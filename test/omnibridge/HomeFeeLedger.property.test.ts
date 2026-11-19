import hre from 'hardhat'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import * as ethers from 'ethers'
import * as fc from 'fast-check'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { feeLedgerInstruction } from '../helpers/helpers'

/*
 * Property tests for HomeFeeLedger. Every property draws cases from one fixed seed, runs each case on the
 * same deployed contracts, and reverts to a snapshot before the next case (loadFixture does both).
 * Each property also counts the cases that reach the paths it exists to test, and fails when a count is
 * below its floor. A generator change that quietly drops a path therefore fails the run.
 *
 * The expected values are computed here, in BigInt, from the rules in the docs of HomeFeeLedger.sol.
 * They do not call the contract to decide what the answer should be.
 */

/** The fixed seed. Every run draws the same cases. Change it on purpose to explore new cases. */
const SEED = 20261119
const RUNS = 200
const TIMEOUT_MS = 1_200_000

const RATE_BASE = 10n ** 18n
const ADDRESS_MAX = 2n ** 160n - 1n
const WORD_MAX = ethers.MaxUint256
const WRAPPED_CAP = 10n ** 21n
const PRIOR_AMOUNT = 1_000_000n
const PRIOR_TERMS = { feeRate: 3n * 10n ** 15n, partner: 'payout', partnerRate: 5n * 10n ** 15n } as const
const ZERO = ethers.ZeroAddress
const INSTRUCTION_BYTES = 160
const REASON_MALFORMED = 0n
const REASON_ZERO_RECIPIENT = 1n
const MODE_NORMAL = 0
const MODE_RETURN_FALSE = 1
const MODE_REVERT = 2

const PARTIES = ['collector', 'payout', 'recipient', 'stranger', 'receiver'] as const
const WALLETS = ['collector', 'payout', 'recipient', 'stranger'] as const
type Party = (typeof PARTIES)[number]
type Wallet = (typeof WALLETS)[number]
type Asset = 'token' | 'wrapped'
type Terms = { feeRate: bigint; partner: Party | 'none'; partnerRate: bigint }
/** The value type an arbitrary generates. */
type Generated<Arb> = Arb extends fc.Arbitrary<infer Value> ? Value : never

/** Counts of the cases that reached each path. Reset at the start of each property. */
const stats = {
    p1: { cases: 0, partnerFee: 0, unwrapped: 0, coinPaid: 0, creditedRecipient: 0, inexactFee: 0, rejectedCoin: 0 },
    p2: { cases: 0, valid: 0, invalid: 0, zeroRecipient: 0, malformed: 0, shortDelivery: 0, priorOwed: 0 },
    p3: { sequences: 0, operations: 0, withdrawals: 0, failedCredits: 0, partnerFee: 0, unwrapped: 0 },
    p4: { cases: 0, coinPaid: 0, creditedNative: 0, creditedWrapped: 0, refusingWrapper: 0, rejectingRecipient: 0, partnerFee: 0 },
}

// ------------------------------------------------------------------ generators

const rateArb = fc.oneof(
    { weight: 3, arbitrary: fc.bigInt({ min: 0n, max: RATE_BASE }) },
    {
        weight: 2,
        arbitrary: fc.constantFrom(0n, 1n, 3n * 10n ** 15n, 5n * 10n ** 15n, RATE_BASE / 2n, RATE_BASE - 1n, RATE_BASE),
    },
)
const partyArb = fc.constantFrom(...PARTIES)
const walletArb = fc.constantFrom(...WALLETS)
const assetArb = fc.constantFrom<Asset>('token', 'wrapped')
const modeArb = fc.oneof(
    { weight: 2, arbitrary: fc.constant(MODE_NORMAL) },
    { weight: 1, arbitrary: fc.constant(MODE_RETURN_FALSE) },
    { weight: 1, arbitrary: fc.constant(MODE_REVERT) },
)
const amountArb = fc.oneof(
    { weight: 4, arbitrary: fc.bigInt({ min: 1n, max: WRAPPED_CAP }) },
    { weight: 1, arbitrary: fc.constantFrom(1n, 2n, 9_999n, 1_000_000n) },
)
const tokenAmountArb = fc.oneof(
    { weight: 9, arbitrary: amountArb },
    { weight: 1, arbitrary: fc.constant(2n ** 250n) },
)

/** Valid terms: fee in [0, 1e18], partner rate in [0, 1e18 - fee], and no partner rate without a partner. */
const termsOver = (partyPool: readonly Party[]): fc.Arbitrary<Terms> => rateArb
    .chain((feeRate) =>
        fc.record({
            feeRate: fc.constant(feeRate),
            partner: fc.constantFrom<Party | 'none'>('none', ...partyPool),
            partnerRate: fc.oneof(
                { weight: 2, arbitrary: fc.bigInt({ min: 0n, max: RATE_BASE - feeRate }) },
                { weight: 1, arbitrary: fc.constant(RATE_BASE - feeRate) },
            ),
        }),
    )
    .map(withoutPartnerRate)
const termsArb = termsOver(PARTIES)
const walletTermsArb = termsOver(WALLETS)

/** Clears the partner rate when there is no partner, the only shape the contract accepts. */
function withoutPartnerRate(terms: Terms): Terms {
    return { ...terms, partnerRate: terms.partner === 'none' ? 0n : terms.partnerRate }
}

const paymentArb = fc.record({
    asset: assetArb,
    amount: tokenAmountArb,
    unwrap: fc.boolean(),
    terms: termsArb,
    recipient: fc.oneof({ weight: 1, arbitrary: partyArb }, { weight: 2, arbitrary: fc.constant<Party>('receiver') }),
    failure: modeArb,
    receiverAccepts: fc.boolean(),
})
type Payment = Generated<typeof paymentArb>

const deliverOpArb = fc.record({
    kind: fc.constant('deliver' as const),
    asset: assetArb,
    amount: amountArb,
    terms: walletTermsArb,
    recipient: walletArb,
    unwrap: fc.boolean(),
    failure: modeArb,
})
const withdrawOpArb = fc.record({
    kind: fc.constant('withdraw' as const),
    asset: assetArb,
    account: walletArb,
    to: fc.constantFrom<'self' | Wallet>('self', ...WALLETS),
})
const sequenceArb = fc.array(
    fc.oneof({ weight: 3, arbitrary: deliverOpArb }, { weight: 2, arbitrary: withdrawOpArb }),
    { minLength: 1, maxLength: 12 },
)
type Operation = Generated<typeof deliverOpArb> | Generated<typeof withdrawOpArb>

const nativeCaseArb = fc.record({
    refusingLedger: fc.boolean(),
    refusingDeposits: fc.boolean(),
    recipient: fc.constantFrom<Party>('recipient', 'payout', 'receiver', 'receiver'),
    receiverAccepts: fc.oneof(
        { weight: 1, arbitrary: fc.constant(true) },
        { weight: 2, arbitrary: fc.constant(false) },
    ),
    unwrap: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
    amount: amountArb,
    terms: termsArb,
})
type NativeCase = Generated<typeof nativeCaseArb>

// ------------------------------------------------------------------ fixture

/** The contracts and accounts every property runs on. Deployed once, then reverted to a snapshot per case. */
interface Harness {
    ledger: ethers.Contract
    refusingLedger: ethers.Contract
    mediator: ethers.Contract
    wrapped: ethers.Contract
    refusingWrapped: ethers.Contract
    token: ethers.Contract
    receiver: ethers.Contract
    parties: Record<Party, string>
    signers: Record<Wallet, HardhatEthersSigner>
    vault: string
}

async function deployContract(name: string, args: unknown[] = []): Promise<ethers.Contract> {
    const contract = await (await hre.ethers.getContractFactory(name)).deploy(...args)
    await contract.waitForDeployment()
    return contract
}

/** Deploys the mocks and both ledgers. Used with loadFixture, so the state reverts after every case. */
async function deployHarness(): Promise<Harness> {
    const [, collector, payout, recipient, stranger, vault] = await hre.ethers.getSigners()
    const mediator = await deployContract('MockHomeMediator')
    const wrapped = await deployContract('WETH')
    const refusingWrapped = await deployContract('MockRefusingWNative')
    const token = await deployContract('MockLedgerToken')
    const receiver = await deployContract('MockPayoutReceiver')
    const mediatorAddress = await mediator.getAddress()
    const ledger = await deployContract('HomeFeeLedger', [
        [mediatorAddress],
        await wrapped.getAddress(),
        collector.address,
        vault.address,
    ])
    const refusingLedger = await deployContract('HomeFeeLedger', [
        [mediatorAddress],
        await refusingWrapped.getAddress(),
        collector.address,
        vault.address,
    ])
    return {
        ledger,
        refusingLedger,
        mediator,
        wrapped,
        refusingWrapped,
        token,
        receiver,
        vault: vault.address,
        signers: { collector, payout, recipient, stranger },
        parties: {
            collector: collector.address,
            payout: payout.address,
            recipient: recipient.address,
            stranger: stranger.address,
            receiver: await receiver.getAddress(),
        },
    }
}

// ------------------------------------------------------------------ encoding and oracle

interface Fields {
    recipient: bigint
    unwrap: bigint
    feeRate: bigint
    partner: bigint
    partnerRate: bigint
}

const toWord = (value: bigint) => ethers.zeroPadValue(ethers.toBeHex(value), 32).slice(2)

/** Five 32 byte words, in the order the contract reads them. Words are not checked, so dirty values pass through. */
function encodeFields(fields: Fields): string {
    const words = [fields.recipient, fields.unwrap, fields.feeRate, fields.partner, fields.partnerRate]
    return `0x${words.map(toWord).join('')}`
}

function partnerWord(h: Harness, partner: Party | 'none'): bigint {
    if (partner === 'none') return 0n
    return BigInt(h.parties[partner])
}

function fieldsFromTerms(h: Harness, recipientAddress: string, unwrap: boolean, terms: Terms): Fields {
    return {
        recipient: BigInt(recipientAddress),
        unwrap: unwrap ? 1n : 0n,
        feeRate: terms.feeRate,
        partner: partnerWord(h, terms.partner),
        partnerRate: terms.partnerRate,
    }
}

function encodeTerms(h: Harness, { recipient, unwrap, terms }: { recipient: string; unwrap: boolean; terms: Terms }) {
    return encodeFields(fieldsFromTerms(h, recipient, unwrap, terms))
}

const wordAt = (bytes: Uint8Array, index: number) => BigInt(ethers.hexlify(bytes.slice(index * 32, index * 32 + 32)))

/**
 * Independent rule for what the contract must do with instruction bytes. Written from the rules, not copied:
 * a wrong length, a word with bits its type cannot hold, an unwrap flag above one, a fee above 1e18, a partner
 * rate with no partner, or a fee plus partner rate above 1e18 is malformed. A zero recipient is refused next.
 */
function classifyInstruction(data: string): { valid: boolean; reason: bigint | null } {
    const bytes = ethers.getBytes(data)
    if (bytes.length !== INSTRUCTION_BYTES) return { valid: false, reason: REASON_MALFORMED }
    const [recipient, unwrap, feeRate, partner, partnerRate] = [0, 1, 2, 3, 4].map((index) => wordAt(bytes, index))
    if (recipient > ADDRESS_MAX || partner > ADDRESS_MAX || unwrap > 1n) return { valid: false, reason: REASON_MALFORMED }
    if (feeRate > RATE_BASE || partnerRate > RATE_BASE - feeRate) return { valid: false, reason: REASON_MALFORMED }
    if (partner === 0n && partnerRate !== 0n) return { valid: false, reason: REASON_MALFORMED }
    if (recipient === 0n) return { valid: false, reason: REASON_ZERO_RECIPIENT }
    return { valid: true, reason: null }
}

/** The gibs fee and partner fee, rounded down, and the rest for the recipient. Plain BigInt arithmetic. */
function splitFor(amount: bigint, terms: Terms) {
    const gibsFee = (amount * terms.feeRate) / RATE_BASE
    const partnerFee = (amount * terms.partnerRate) / RATE_BASE
    return { gibsFee, partnerFee, toRecipient: amount - gibsFee - partnerFee }
}

// ------------------------------------------------------------------ chain reads and snapshots

const balanceReader = (asset: string) =>
    new ethers.Contract(asset, ['function balanceOf(address) view returns (uint256)'], hre.ethers.provider)

/** Native coin for the zero address, otherwise the token's balance. */
async function heldOf(asset: string, holder: string): Promise<bigint> {
    if (asset === ZERO) return hre.ethers.provider.getBalance(holder)
    return balanceReader(asset).balanceOf(holder)
}

const keyOf = (asset: string, holder: string) => `${asset.toLowerCase()}|${holder.toLowerCase()}`
const assetKey = (asset: string) => asset.toLowerCase()
const addressKey = (address: string) => address.toLowerCase()
const read = (map: Map<string, bigint>, mapKey: string) => map.get(mapKey) ?? 0n
const add = (map: Map<string, bigint>, mapKey: string, amount: bigint) => map.set(mapKey, read(map, mapKey) + amount)

interface Snapshot {
    held: Map<string, bigint>
    owed: Map<string, bigint>
    ledgerHeld: Map<string, bigint>
    totalOwed: Map<string, bigint>
}

async function takeSnapshot(ledger: ethers.Contract, assets: string[], holders: string[]): Promise<Snapshot> {
    const ledgerAddress = await ledger.getAddress()
    const snapshot: Snapshot = { held: new Map(), owed: new Map(), ledgerHeld: new Map(), totalOwed: new Map() }
    for (const asset of assets) {
        snapshot.ledgerHeld.set(assetKey(asset), await heldOf(asset, ledgerAddress))
        snapshot.totalOwed.set(assetKey(asset), await ledger.totalOwed(asset))
        for (const holder of holders) {
            snapshot.held.set(keyOf(asset, holder), await heldOf(asset, holder))
            snapshot.owed.set(keyOf(asset, holder), await ledger.owed(asset, holder))
        }
    }
    return snapshot
}

const changedHeld = (before: Snapshot, after: Snapshot, asset: string, holder: string) =>
    read(after.held, keyOf(asset, holder)) - read(before.held, keyOf(asset, holder))
const changedOwed = (before: Snapshot, after: Snapshot, asset: string, holder: string) =>
    read(after.owed, keyOf(asset, holder)) - read(before.owed, keyOf(asset, holder))

/** Everything a holder gained: tokens or coin it was paid, plus what it was credited in the ledger. */
function valueTo(before: Snapshot, after: Snapshot, assets: string[], holder: string): bigint {
    return assets.reduce(
        (sum, asset) => sum + changedHeld(before, after, asset, holder) + changedOwed(before, after, asset, holder),
        0n,
    )
}

/** Units of the asset and of native coin that the accounting covers. The wrapped token and coin count as one unit. */
const accountingAssets = (asset: string) => [asset, ZERO]

async function assetAddressOf(h: Harness, asset: Asset): Promise<string> {
    if (asset === 'token') return h.token.getAddress()
    return h.wrapped.getAddress()
}

async function fund(h: Harness, { asset, amount, wrappedContract }: { asset: Asset; amount: bigint; wrappedContract: ethers.Contract }) {
    const mediatorAddress = await h.mediator.getAddress()
    if (asset === 'token') {
        await h.token.mint(mediatorAddress, amount)
        return
    }
    await wrappedContract.connect(h.signers.stranger).deposit({ value: amount })
    await wrappedContract.connect(h.signers.stranger).transfer(mediatorAddress, amount)
}

function partnerAddressOf(h: Harness, terms: Terms): string {
    if (terms.partner === 'none') return ZERO
    return h.parties[terms.partner]
}

// ------------------------------------------------------------------ property 1: one delivery splits exactly

/**
 * Checks one delivery on a fresh ledger. Each party's gain (paid plus credited) must equal the exact
 * expected amount, the gains must add up to the amount that arrived, and the ledger must hold what it owes.
 */
async function checkPayment(h: Harness, payment: Payment) {
    const assetAddress = await assetAddressOf(h, payment.asset)
    const amount = payment.asset === 'wrapped' && payment.amount > WRAPPED_CAP ? WRAPPED_CAP : payment.amount
    const ledgerAddress = await h.ledger.getAddress()
    await fund(h, { asset: payment.asset, amount, wrappedContract: h.wrapped })
    await h.token.setTransferMode(payment.failure, ledgerAddress)
    await h.receiver.setAccepting(payment.receiverAccepts)

    const recipientAddress = h.parties[payment.recipient]
    const data = encodeTerms(h, { recipient: recipientAddress, unwrap: payment.unwrap, terms: payment.terms })
    const assets = accountingAssets(assetAddress)
    const holders = PARTIES.map((party) => h.parties[party])
    const before = await takeSnapshot(h.ledger, assets, holders)
    await h.mediator.deliver(assetAddress, ledgerAddress, amount, amount, data)
    expect(await h.mediator.lastCallbackSucceeded(), 'callback must not fail on valid terms').to.equal(true)
    const after = await takeSnapshot(h.ledger, assets, holders)

    const split = splitFor(amount, payment.terms)
    const expected = new Map<string, bigint>()
    add(expected, addressKey(h.parties.collector), split.gibsFee)
    add(expected, addressKey(partnerAddressOf(h, payment.terms)), split.partnerFee)
    add(expected, addressKey(recipientAddress), split.toRecipient)
    for (const party of PARTIES) {
        const holder = h.parties[party]
        expect(valueTo(before, after, assets, holder), `value to ${party}`).to.equal(read(expected, addressKey(holder)))
    }
    const totalValue = PARTIES.reduce((sum, party) => sum + valueTo(before, after, assets, h.parties[party]), 0n)
    expect(totalValue, 'the gains add up to exactly the amount received').to.equal(amount)
    for (const asset of assets) {
        const owedSum = PARTIES.reduce((sum, party) => sum + read(after.owed, keyOf(asset, h.parties[party])), 0n)
        expect(read(after.totalOwed, assetKey(asset)), `totalOwed for ${asset}`).to.equal(owedSum)
        expect(read(after.ledgerHeld, assetKey(asset)), `ledger balance for ${asset}`).to.equal(read(after.totalOwed, assetKey(asset)))
    }

    stats.p1.cases++
    if (split.partnerFee > 0n) stats.p1.partnerFee++
    if (payment.asset === 'wrapped' && payment.unwrap) stats.p1.unwrapped++
    if (changedHeld(before, after, ZERO, recipientAddress) > 0n) stats.p1.coinPaid++
    if (changedOwed(before, after, assetAddress, recipientAddress) + changedOwed(before, after, ZERO, recipientAddress) > 0n) {
        stats.p1.creditedRecipient++
    }
    if ((amount * payment.terms.feeRate) % RATE_BASE !== 0n) stats.p1.inexactFee++
    const rejectedCoin = payment.recipient === 'receiver' && payment.asset === 'wrapped' && payment.unwrap && !payment.receiverAccepts
    if (rejectedCoin) stats.p1.rejectedCoin++
}

// ------------------------------------------------------------------ property 2: invalid terms stay accounted

const validFieldsArb = (h: Harness) =>
    fc.record({ recipient: partyArb, unwrap: fc.boolean(), terms: termsArb }).map(({ recipient, unwrap, terms }) =>
        fieldsFromTerms(h, h.parties[recipient], unwrap, terms),
    )
const dirtyWordArb = (minimum: bigint) => fc.bigInt({ min: minimum, max: WORD_MAX })

/** Instruction bytes for a mix of valid and invalid terms, plus raw bytes of the wrong length. */
function probeDataArb(h: Harness): fc.Arbitrary<string> {
    const probes = [
        { weight: 4, arbitrary: validFieldsArb(h).map(encodeFields) },
        {
            weight: 1,
            arbitrary: fc.tuple(validFieldsArb(h), dirtyWordArb(RATE_BASE + 1n)).map(([fields, fee]) =>
                encodeFields({ ...fields, feeRate: fee }),
            ),
        },
        {
            weight: 1,
            arbitrary: fc.tuple(validFieldsArb(h), dirtyWordArb(1n)).map(([fields, extra]) =>
                encodeFields({
                    ...fields,
                    partner: fields.partner === 0n ? BigInt(h.parties.payout) : fields.partner,
                    partnerRate: RATE_BASE - fields.feeRate + (extra % (WORD_MAX - RATE_BASE)) + 1n,
                }),
            ),
        },
        {
            weight: 1,
            arbitrary: validFieldsArb(h).map((fields) => encodeFields({ ...fields, partner: 0n, partnerRate: 1n })),
        },
        {
            weight: 1,
            arbitrary: fc.tuple(validFieldsArb(h), dirtyWordArb(ADDRESS_MAX + 1n)).map(([fields, dirty]) =>
                encodeFields({ ...fields, recipient: dirty }),
            ),
        },
        {
            weight: 1,
            arbitrary: fc.tuple(validFieldsArb(h), dirtyWordArb(ADDRESS_MAX + 1n)).map(([fields, dirty]) =>
                encodeFields({ ...fields, partner: dirty }),
            ),
        },
        {
            weight: 1,
            arbitrary: fc.tuple(validFieldsArb(h), dirtyWordArb(2n)).map(([fields, unwrap]) =>
                encodeFields({ ...fields, unwrap }),
            ),
        },
        {
            weight: 1,
            arbitrary: validFieldsArb(h).map((fields) => encodeFields({ ...fields, recipient: 0n })),
        },
        {
            weight: 1,
            arbitrary: fc
                .uint8Array({ minLength: 0, maxLength: 400 })
                .filter((bytes) => bytes.length !== INSTRUCTION_BYTES)
                .map((bytes) => ethers.hexlify(bytes)),
        },
    ]
    return fc.oneof(...probes)
}

const valueAndTransferredArb = amountArb.chain((value) =>
    fc.record({
        value: fc.constant(value),
        transferred: fc.oneof(
            { weight: 1, arbitrary: fc.constant(value) },
            { weight: 1, arbitrary: fc.bigInt({ min: 1n, max: value }) },
        ),
    }),
)

interface Probe {
    data: string
    value: bigint
    transferred: bigint
    prior: boolean
}

interface LedgerOutcome {
    delivered: boolean
    skipReason: bigint | null
}

/** The ledger events in one receipt. The mediator and the token emit their own events, which are ignored here. */
function ledgerOutcome(h: Harness, receipt: ethers.ContractTransactionReceipt, ledgerAddress: string): LedgerOutcome {
    const events = receipt.logs
        .filter((log) => addressKey(log.address) === addressKey(ledgerAddress))
        .map((log) => h.ledger.interface.parseLog(log))
    const skipped = events.find((event) => event?.name === 'Skipped')
    return {
        delivered: events.some((event) => event?.name === 'Delivered'),
        skipReason: skipped ? (skipped.args.reason as bigint) : null,
    }
}

async function checkProbe(h: Harness, probe: Probe) {
    const ledgerAddress = await h.ledger.getAddress()
    const tokenAddress = await h.token.getAddress()
    if (probe.prior) {
        await fund(h, { asset: 'token', amount: PRIOR_AMOUNT, wrappedContract: h.wrapped })
        await h.mediator.deliver(
            tokenAddress,
            ledgerAddress,
            PRIOR_AMOUNT,
            PRIOR_AMOUNT,
            encodeTerms(h, { recipient: h.parties.recipient, unwrap: false, terms: { ...PRIOR_TERMS } }),
        )
        expect(await h.mediator.lastCallbackSucceeded()).to.equal(true)
    }

    await fund(h, { asset: 'token', amount: probe.transferred, wrappedContract: h.wrapped })
    const assets = accountingAssets(tokenAddress)
    const holders = PARTIES.map((party) => h.parties[party])
    const before = await takeSnapshot(h.ledger, assets, holders)
    const receipt = (await (await h.mediator.deliver(tokenAddress, ledgerAddress, probe.transferred, probe.value, probe.data)).wait()) as ethers.ContractTransactionReceipt
    expect(await h.mediator.lastCallbackSucceeded(), 'the ledger must never revert a delivery').to.equal(true)
    const after = await takeSnapshot(h.ledger, assets, holders)

    const verdict = classifyInstruction(probe.data)
    const outcome = ledgerOutcome(h, receipt, ledgerAddress)
    if (verdict.valid) {
        expect(outcome.delivered, 'valid terms must be delivered').to.equal(true)
    } else {
        expect(outcome.delivered, 'invalid terms must not be delivered').to.equal(false)
        expect(outcome.skipReason, 'skip reason').to.equal(verdict.reason)
    }

    // Every unit that arrived is either paid, credited, or unaccounted (rescuable). Nothing else can happen to it.
    const paid = PARTIES.reduce((sum, party) => sum + changedHeld(before, after, tokenAddress, h.parties[party]), 0n)
    const credited = PARTIES.reduce((sum, party) => sum + changedOwed(before, after, tokenAddress, h.parties[party]), 0n)
    const rescuableBefore = read(before.ledgerHeld, assetKey(tokenAddress)) - read(before.totalOwed, assetKey(tokenAddress))
    const rescuableAfter = read(after.ledgerHeld, assetKey(tokenAddress)) - read(after.totalOwed, assetKey(tokenAddress))
    const rescuable = rescuableAfter - rescuableBefore
    expect(paid + credited + rescuable, 'every unit that arrived stays accounted for').to.equal(probe.transferred)
    expect(paid + credited <= probe.transferred, 'the ledger never pays out more than it received').to.equal(true)
    for (const asset of assets) {
        expect(
            read(after.totalOwed, assetKey(asset)) <= read(after.ledgerHeld, assetKey(asset)),
            `totalOwed must not exceed the ledger balance of ${asset}`,
        ).to.equal(true)
    }
    if (verdict.valid) {
        expect(rescuable, 'a valid delivery leaves nothing unaccounted').to.equal(0n)
    } else {
        expect(paid, 'invalid terms pay nobody').to.equal(0n)
        expect(credited, 'invalid terms credit nobody').to.equal(0n)
        expect(rescuable, 'invalid terms leave the whole amount rescuable').to.equal(probe.transferred)
    }
    if (rescuable > 0n) {
        const vaultBefore = await balanceReader(tokenAddress).balanceOf(h.vault)
        await h.ledger.rescueUnaccounted(tokenAddress)
        const vaultAfter = await balanceReader(tokenAddress).balanceOf(h.vault)
        expect(vaultAfter - vaultBefore, 'rescue sends exactly the unaccounted amount').to.equal(rescuable)
    }

    stats.p2.cases++
    if (verdict.valid) stats.p2.valid++
    if (!verdict.valid) stats.p2.invalid++
    if (verdict.reason === REASON_ZERO_RECIPIENT) stats.p2.zeroRecipient++
    if (verdict.reason === REASON_MALFORMED) stats.p2.malformed++
    if (probe.transferred < probe.value) stats.p2.shortDelivery++
    if (probe.prior) stats.p2.priorOwed++
}

// ------------------------------------------------------------------ property 3: withdraw and ledger model

interface Model {
    held: Map<string, bigint>
    owed: Map<string, bigint>
    total: Map<string, bigint>
}

const emptyModel = (): Model => ({ held: new Map(), owed: new Map(), total: new Map() })

/** The model's view of what a holder can withdraw, in one asset. */
const modelOwed = (model: Model, asset: string, holder: string) => read(model.owed, keyOf(asset, holder))

function modelCredit(h: Harness, model: Model, asset: string, party: Party, amount: bigint) {
    const holder = h.parties[party]
    add(model.owed, keyOf(asset, holder), amount)
    add(model.total, assetKey(asset), amount)
}

async function applyDelivery(h: Harness, model: Model, operation: Generated<typeof deliverOpArb>) {
    const assetAddress = await assetAddressOf(h, operation.asset)
    const ledgerAddress = await h.ledger.getAddress()
    await h.token.setTransferMode(operation.failure, ledgerAddress)
    await fund(h, { asset: operation.asset, amount: operation.amount, wrappedContract: h.wrapped })
    add(model.held, assetKey(assetAddress), operation.amount)
    const recipientAddress = h.parties[operation.recipient]
    const data = encodeTerms(h, { recipient: recipientAddress, unwrap: operation.unwrap, terms: operation.terms })
    await h.mediator.deliver(assetAddress, ledgerAddress, operation.amount, operation.amount, data)
    expect(await h.mediator.lastCallbackSucceeded()).to.equal(true)

    // The ledger's free balance is what arrived. The delivery takes all of it, because the value is the full amount.
    const available = read(model.held, assetKey(assetAddress)) - read(model.total, assetKey(assetAddress))
    const split = splitFor(available, operation.terms)
    modelCredit(h, model, assetAddress, 'collector', split.gibsFee)
    if (operation.terms.partner !== 'none') modelCredit(h, model, assetAddress, operation.terms.partner, split.partnerFee)
    if (split.partnerFee > 0n) stats.p3.partnerFee++
    if (operation.asset === 'wrapped' && operation.unwrap) stats.p3.unwrapped++
    if (split.toRecipient === 0n) return
    const paysOut = operation.asset === 'wrapped' || operation.failure === MODE_NORMAL
    if (paysOut) {
        add(model.held, assetKey(assetAddress), -split.toRecipient)
        return
    }
    modelCredit(h, model, assetAddress, operation.recipient, split.toRecipient)
    stats.p3.failedCredits++
}

async function applyWithdrawal(h: Harness, model: Model, operation: Generated<typeof withdrawOpArb>) {
    const assetAddress = await assetAddressOf(h, operation.asset)
    const ledgerAddress = await h.ledger.getAddress()
    await h.token.setTransferMode(MODE_NORMAL, ledgerAddress)
    const accountAddress = h.parties[operation.account]
    const toAddress = operation.to === 'self' ? accountAddress : h.parties[operation.to]
    const owedAmount = modelOwed(model, assetAddress, accountAddress)
    const ledgerAsAccount = h.ledger.connect(h.signers[operation.account])
    const attempt =
        operation.to === 'self'
            ? ledgerAsAccount.withdraw(assetAddress)
            : ledgerAsAccount.withdrawTo(assetAddress, toAddress)
    if (owedAmount === 0n) {
        await expect(attempt).to.be.revertedWithCustomError(h.ledger, 'NothingToPay')
        return
    }
    const receivedBefore = await heldOf(assetAddress, toAddress)
    await expect(attempt).to.emit(h.ledger, 'Withdrawn')
    const receivedAfter = await heldOf(assetAddress, toAddress)
    expect(receivedAfter - receivedBefore, `${operation.account} receives exactly what it is owed`).to.equal(owedAmount)
    add(model.owed, keyOf(assetAddress, accountAddress), -owedAmount)
    add(model.total, assetKey(assetAddress), -owedAmount)
    add(model.held, assetKey(assetAddress), -owedAmount)
    stats.p3.withdrawals++
}

async function applyOperation(h: Harness, model: Model, operation: Operation) {
    stats.p3.operations++
    if (operation.kind === 'deliver') return applyDelivery(h, model, operation)
    return applyWithdrawal(h, model, operation)
}

/** Compares the contract with the model: owed per holder, totalOwed, the ledger balance, and no native coin. */
async function expectMatchesModel(h: Harness, model: Model) {
    const ledgerAddress = await h.ledger.getAddress()
    for (const asset of [await h.token.getAddress(), await h.wrapped.getAddress()]) {
        expect(await h.ledger.totalOwed(asset), 'totalOwed').to.equal(read(model.total, assetKey(asset)))
        expect(await heldOf(asset, ledgerAddress), 'ledger balance').to.equal(read(model.held, assetKey(asset)))
        let owedSum = 0n
        for (const wallet of WALLETS) {
            const holder = h.parties[wallet]
            const owed = await h.ledger.owed(asset, holder)
            expect(owed, `owed to ${wallet}`).to.equal(modelOwed(model, asset, holder))
            owedSum += owed
        }
        expect(owedSum, 'totalOwed equals the sum of owed').to.equal(read(model.total, assetKey(asset)))
    }
    expect(await hre.ethers.provider.getBalance(ledgerAddress), 'no native coin in this property').to.equal(0n)
}

/** Withdraws every balance that is still owed, so each wallet's total is checked against the model. */
async function drainAll(h: Harness, model: Model) {
    for (const asset of ['token', 'wrapped'] as Asset[]) {
        for (const wallet of WALLETS) {
            const assetAddress = await assetAddressOf(h, asset)
            if (modelOwed(model, assetAddress, h.parties[wallet]) > 0n) {
                await applyWithdrawal(h, model, { kind: 'withdraw', asset, account: wallet, to: 'self' })
            }
        }
    }
    await expectMatchesModel(h, model)
    const ledgerAddress = await h.ledger.getAddress()
    expect(await heldOf(await h.token.getAddress(), ledgerAddress), 'token fully paid out').to.equal(0n)
    expect(await heldOf(await h.wrapped.getAddress(), ledgerAddress), 'wrapped fully paid out').to.equal(0n)
}

// ------------------------------------------------------------------ property 4: native payout path

type Route = 'token' | 'coin' | 'wrapped-credit' | 'native-credit'

/** Which path a native payout takes. Pure: the route follows from the flags, not from the contract. */
function routeOf({ unwrap, coinSent, wrapBack }: { unwrap: boolean; coinSent: boolean; wrapBack: boolean }): Route {
    if (!unwrap) return 'token'
    if (coinSent) return 'coin'
    if (wrapBack) return 'wrapped-credit'
    return 'native-credit'
}

async function checkNativeCase(h: Harness, kase: NativeCase) {
    const ledger = kase.refusingLedger ? h.refusingLedger : h.ledger
    const wrappedContract = kase.refusingLedger ? h.refusingWrapped : h.wrapped
    const ledgerAddress = await ledger.getAddress()
    const wrappedAddress = await wrappedContract.getAddress()
    const depositsRefused = kase.refusingLedger && kase.refusingDeposits
    const coinSent = kase.recipient !== 'receiver' || kase.receiverAccepts
    const wrapBack = !depositsRefused

    await fund(h, { asset: 'wrapped', amount: kase.amount, wrappedContract })
    if (kase.refusingLedger) await h.refusingWrapped.setRefusingDeposits(depositsRefused)
    await h.receiver.setAccepting(kase.receiverAccepts)

    const recipientAddress = h.parties[kase.recipient]
    const data = encodeTerms(h, { recipient: recipientAddress, unwrap: kase.unwrap, terms: kase.terms })
    const holders = PARTIES.map((party) => h.parties[party])
    const assets = accountingAssets(wrappedAddress)
    const before = await takeSnapshot(ledger, assets, holders)
    await h.mediator.deliver(wrappedAddress, ledgerAddress, kase.amount, kase.amount, data)
    expect(await h.mediator.lastCallbackSucceeded(), 'the ledger must never revert a delivery').to.equal(true)
    const after = await takeSnapshot(ledger, assets, holders)

    const split = splitFor(kase.amount, kase.terms)
    const feeToRecipient = kase.terms.partner === kase.recipient ? split.partnerFee : 0n
    const route = routeOf({ unwrap: kase.unwrap, coinSent, wrapBack })
    const coinGain = changedHeld(before, after, ZERO, recipientAddress)
    const wrappedHeldGain = changedHeld(before, after, wrappedAddress, recipientAddress)
    const wrappedCreditGain = changedOwed(before, after, wrappedAddress, recipientAddress)
    const nativeCreditGain = changedOwed(before, after, ZERO, recipientAddress)

    // The recipient's share of the amount is paid or credited in exactly one place. Fees to the same account are counted apart.
    const expectedCoin = route === 'coin' ? split.toRecipient : 0n
    const expectedWrappedHeld = route === 'token' ? split.toRecipient : 0n
    const expectedWrappedCredit = (route === 'wrapped-credit' ? split.toRecipient : 0n) + feeToRecipient
    const expectedNativeCredit = route === 'native-credit' ? split.toRecipient : 0n
    expect(coinGain, `coin to recipient on route ${route}`).to.equal(expectedCoin)
    expect(wrappedHeldGain, `wrapped token paid on route ${route}`).to.equal(expectedWrappedHeld)
    expect(wrappedCreditGain, `wrapped credit on route ${route}`).to.equal(expectedWrappedCredit)
    expect(nativeCreditGain, `native credit on route ${route}`).to.equal(expectedNativeCredit)
    expect(coinGain + wrappedHeldGain + nativeCreditGain + wrappedCreditGain - feeToRecipient, 'recipient share is exact').to.equal(
        split.toRecipient,
    )

    // Nothing is held without an owner: native coin in the ledger equals native credits, and the wrapped balance equals wrapped credits.
    expect(await hre.ethers.provider.getBalance(ledgerAddress), 'native coin held equals native owed').to.equal(
        await ledger.totalOwed(ZERO),
    )
    expect(await heldOf(wrappedAddress, ledgerAddress), 'wrapped held equals wrapped owed').to.equal(
        await ledger.totalOwed(wrappedAddress),
    )

    // A coin credit is not stuck: once the recipient accepts coin, it claims the credit in full.
    if (nativeCreditGain > 0n) {
        await h.receiver.setAccepting(true)
        const claimed = await hre.ethers.provider.getBalance(h.parties.receiver)
        await h.receiver.claimNative(ledgerAddress)
        expect(await hre.ethers.provider.getBalance(h.parties.receiver), 'the credit is claimable').to.equal(claimed + nativeCreditGain)
        expect(await ledger.owed(ZERO, recipientAddress)).to.equal(0n)
        expect(await ledger.totalOwed(ZERO)).to.equal(0n)
    }

    stats.p4.cases++
    if (route === 'coin') stats.p4.coinPaid++
    if (route === 'native-credit') stats.p4.creditedNative++
    if (route === 'wrapped-credit') stats.p4.creditedWrapped++
    if (kase.refusingLedger && kase.refusingDeposits && kase.unwrap) stats.p4.refusingWrapper++
    if (kase.recipient === 'receiver' && !kase.receiverAccepts && kase.unwrap) stats.p4.rejectingRecipient++
    if (split.partnerFee > 0n) stats.p4.partnerFee++
}

// ------------------------------------------------------------------ tests

function requireFloors(label: string, counts: Record<string, number>, floors: Record<string, number>) {
    console.log(`      ${label} path counts over ${RUNS} runs: ${JSON.stringify(counts)}`)
    for (const [name, floor] of Object.entries(floors)) {
        expect(counts[name], `${label}: runs that reached ${name}`).to.be.at.least(floor)
    }
}

describe('HomeFeeLedger property tests', () => {
    it('encodes the instruction the same way as the unit test helper', async () => {
        const h = await loadFixture(deployHarness)
        const fields = fieldsFromTerms(h, h.parties.recipient, true, {
            feeRate: 3n * 10n ** 15n,
            partner: 'payout',
            partnerRate: 5n * 10n ** 15n,
        })
        const expectedHex = feeLedgerInstruction(h.parties.recipient, {
            unwrap: true,
            feeRate: 3n * 10n ** 15n,
            partner: h.parties.payout,
            partnerRate: 5n * 10n ** 15n,
        })
        expect(encodeFields(fields)).to.equal(expectedHex)
        expect(classifyInstruction(expectedHex)).to.deep.equal({ valid: true, reason: null })
    })

    it('P1 every delivery splits exactly, and nobody is credited more than arrived', async function () {
        this.timeout(TIMEOUT_MS)
        Object.assign(stats.p1, { cases: 0, partnerFee: 0, unwrapped: 0, coinPaid: 0, creditedRecipient: 0, inexactFee: 0, rejectedCoin: 0 })
        await fc.assert(
            fc.asyncProperty(paymentArb, async (payment) => {
                const h = await loadFixture(deployHarness)
                await checkPayment(h, payment)
            }),
            { seed: SEED, numRuns: RUNS },
        )
        requireFloors('P1', stats.p1, {
            partnerFee: 40,
            unwrapped: 25,
            coinPaid: 10,
            creditedRecipient: 25,
            inexactFee: 100,
            rejectedCoin: 3,
        })
    })

    it('P2 invalid terms never pay more than arrived and stay accounted for', async function () {
        this.timeout(TIMEOUT_MS)
        Object.assign(stats.p2, { cases: 0, valid: 0, invalid: 0, zeroRecipient: 0, malformed: 0, shortDelivery: 0, priorOwed: 0 })
        const h = await loadFixture(deployHarness)
        const probeArb: fc.Arbitrary<Probe> = fc
            .record({ data: probeDataArb(h), amounts: valueAndTransferredArb, prior: fc.boolean() })
            .map(({ data, amounts, prior }) => ({ data, ...amounts, prior }))
        await fc.assert(
            fc.asyncProperty(probeArb, async (probe) => {
                await loadFixture(deployHarness)
                await checkProbe(h, probe)
            }),
            { seed: SEED, numRuns: RUNS },
        )
        requireFloors('P2', stats.p2, {
            valid: 20,
            invalid: 100,
            zeroRecipient: 3,
            malformed: 60,
            shortDelivery: 50,
            priorOwed: 30,
        })
    })

    it('P3 each account withdraws exactly what it is owed, and totalOwed is the sum of owed', async function () {
        this.timeout(TIMEOUT_MS)
        Object.assign(stats.p3, { sequences: 0, operations: 0, withdrawals: 0, failedCredits: 0, partnerFee: 0, unwrapped: 0 })
        await fc.assert(
            fc.asyncProperty(sequenceArb, async (operations) => {
                const h = await loadFixture(deployHarness)
                stats.p3.sequences++
                const model = emptyModel()
                for (const operation of operations) {
                    await applyOperation(h, model, operation)
                    await expectMatchesModel(h, model)
                }
                await drainAll(h, model)
            }),
            { seed: SEED, numRuns: RUNS },
        )
        requireFloors('P3', stats.p3, {
            operations: 1000,
            withdrawals: 100,
            failedCredits: 30,
            partnerFee: 30,
            unwrapped: 10,
        })
    })

    it('P4 native payouts are paid or credited, never lost, including a recipient and a wrapper that refuse', async function () {
        this.timeout(TIMEOUT_MS)
        Object.assign(stats.p4, {
            cases: 0,
            coinPaid: 0,
            creditedNative: 0,
            creditedWrapped: 0,
            refusingWrapper: 0,
            rejectingRecipient: 0,
            partnerFee: 0,
        })
        await fc.assert(
            fc.asyncProperty(nativeCaseArb, async (kase) => {
                const h = await loadFixture(deployHarness)
                await checkNativeCase(h, kase)
            }),
            { seed: SEED, numRuns: RUNS },
        )
        requireFloors('P4', stats.p4, {
            coinPaid: 40,
            creditedNative: 10,
            creditedWrapped: 10,
            refusingWrapper: 30,
            rejectingRecipient: 30,
            partnerFee: 20,
        })
    })
})
