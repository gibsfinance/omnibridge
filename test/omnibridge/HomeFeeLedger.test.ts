import hre from 'hardhat'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import * as ethers from 'ethers'
import * as helpers from '../helpers/helpers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'

const ZERO = ethers.ZeroAddress
const coder = ethers.AbiCoder.defaultAbiCoder()
const amount = 1_000_000n
const SkipReason = { MalformedData: 0n, ZeroRecipient: 1n, NothingAvailable: 2n, Reentrant: 3n }

const instruction = helpers.feeLedgerInstruction
const rate = helpers.percentRate

describe('HomeFeeLedger', () => {
    let owner!: HardhatEthersSigner
    let collector!: HardhatEthersSigner
    let payout!: HardhatEthersSigner
    let user!: HardhatEthersSigner
    let recipient!: HardhatEthersSigner
    let stranger!: HardhatEthersSigner
    let vault!: HardhatEthersSigner
    let mediator: any
    let otherMediator: any
    let ledger: any
    let token: any
    let wNative: any

    const deploy = async () => {
        ;[owner, collector, payout, user, recipient, stranger, vault] = await hre.ethers.getSigners()
        mediator = await (await hre.ethers.getContractFactory('MockHomeMediator')).deploy()
        otherMediator = await (await hre.ethers.getContractFactory('MockHomeMediator')).deploy()
        wNative = await (await hre.ethers.getContractFactory('WETH')).deploy()
        token = await (await hre.ethers.getContractFactory('MockLedgerToken')).deploy()
        ledger = await (await hre.ethers.getContractFactory('HomeFeeLedger')).deploy(
            [mediator, otherMediator], wNative, collector, vault,
        )
    }

    beforeEach(async () => {
        await loadFixture(deploy)
    })

    const deliver = async (data: string, transferred = amount, value = amount, from = mediator, asset = token) => {
        await asset.mint(from, transferred)
        return from.deliver(asset, ledger, transferred, value, data)
    }
    const ledgerBalance = (asset = token) => asset.balanceOf(ledger)
    const withPartner = (feeRate: bigint, partnerRate: bigint) => ({ feeRate, partner: payout.address, partnerRate })

    describe('construction', () => {
        it('fixes constants, mediators, collector and rescue recipient', async () => {
            expect(await ledger.MAXIMUM_FEE_RATE_E18()).to.equal(10n ** 16n)
            expect(await ledger.MAXIMUM_PARTNER_RATE_E18()).to.equal(10n ** 16n)
            expect(await ledger.RATE_BASE_E18()).to.equal(10n ** 18n)
            expect(await ledger.isMediator(mediator)).to.equal(true)
            expect(await ledger.isMediator(otherMediator)).to.equal(true)
            expect(await ledger.isMediator(stranger)).to.equal(false)
            expect(await ledger.gibsCollector()).to.equal(collector.address)
            expect(await ledger.rescueRecipient()).to.equal(vault.address)
        })
        it('rejects bad arguments', async () => {
            const factory = await hre.ethers.getContractFactory('HomeFeeLedger')
            await expect(factory.deploy([], wNative, collector, vault)).to.be.revertedWithCustomError(ledger, 'NoMediators')
            await expect(factory.deploy([ZERO], wNative, collector, vault)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
            await expect(factory.deploy([mediator], ZERO, collector, vault)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
            await expect(factory.deploy([mediator], wNative, ZERO, vault)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
            await expect(factory.deploy([mediator], wNative, collector, ZERO)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
        })
        it('has no admin, no setter and no partner registry', async () => {
            const writes = ledger.interface.fragments
                .filter((fragment: any) => fragment.type === 'function' && fragment.stateMutability !== 'view' && fragment.stateMutability !== 'pure')
                .map((fragment: any) => fragment.name)
                .sort()
            expect(writes).to.deep.equal(['onTokenBridged', 'relay', 'relayNative', 'rescueUnaccounted', 'withdraw', 'withdrawTo'])
            const names = ledger.interface.fragments.map((fragment: any) => fragment.name)
            for (const gone of ['admin', 'gibsRate', 'setGibsRate', 'registerPartner', 'partners', 'partnerCount', 'renounceAdmin']) {
                expect(names).to.not.include(gone)
            }
        })
    })

    describe('inbound', () => {
        it('splits with a partner and pays the rest', async () => {
            const receipt = await (await deliver(instruction(recipient.address, withPartner(rate(0.3), rate(0.5))))).wait()
            console.log(`      inbound split with partner, gas for the whole delivery: ${receipt.gasUsed}`)
            expect(await token.balanceOf(recipient)).to.equal(amount - 3_000n - 5_000n)
            expect(await ledger.owed(token, collector)).to.equal(3_000n)
            expect(await ledger.owed(token, payout)).to.equal(5_000n)
            expect(await ledger.totalOwed(token)).to.equal(8_000n)
            expect(await ledgerBalance()).to.equal(8_000n)
            expect(await mediator.lastCallbackSucceeded()).to.equal(true)
        })
        it('takes exactly the rate in the data, whatever it is', async () => {
            await deliver(instruction(recipient.address, { feeRate: rate(0.25) }))
            expect(await ledger.owed(token, collector)).to.equal(2_500n)
            await deliver(instruction(recipient.address, { feeRate: rate(1) }))
            expect(await ledger.owed(token, collector)).to.equal(2_500n + 10_000n)
            await deliver(instruction(recipient.address, { feeRate: 0n }))
            expect(await ledger.owed(token, collector)).to.equal(12_500n)
            expect(await token.balanceOf(recipient)).to.equal(amount - 2_500n + amount - 10_000n + amount)
        })
        it('accepts the highest rates in both parts', async () => {
            await deliver(instruction(recipient.address, withPartner(rate(1), rate(1))))
            expect(await ledger.owed(token, collector)).to.equal(10_000n)
            expect(await ledger.owed(token, payout)).to.equal(10_000n)
            expect(await token.balanceOf(recipient)).to.equal(amount - 20_000n)
        })
        it('accepts the cap exactly and refuses one unit above it', async () => {
            await deliver(instruction(recipient.address, { feeRate: 10n ** 16n }))
            expect(await ledger.owed(token, collector)).to.equal(10_000n)
            await expect(deliver(instruction(recipient.address, { feeRate: 10n ** 16n + 1n }))).to.emit(ledger, 'Skipped')
                .withArgs(mediator, token, amount, SkipReason.MalformedData)
            await expect(deliver(instruction(recipient.address, { feeRate: ethers.MaxUint256 }))).to.emit(ledger, 'Skipped')
                .withArgs(mediator, token, amount, SkipReason.MalformedData)
            expect(await mediator.lastCallbackSucceeded()).to.equal(true)
        })
        it('does not overflow for a huge delivery', async () => {
            const huge = 2n ** 250n
            await deliver(instruction(recipient.address, withPartner(rate(1), rate(1))), huge, huge)
            expect(await ledger.owed(token, collector)).to.equal(huge / 100n)
            expect(await ledger.owed(token, payout)).to.equal(huge / 100n)
            expect(await token.balanceOf(recipient)).to.equal(huge - 2n * (huge / 100n))
        })
        it('rounds each fee down and gives the dust to the recipient', async () => {
            const odd = 9_999n
            await deliver(instruction(recipient.address, withPartner(rate(0.3), rate(0.5))), odd, odd)
            // 9_999 * 0.3% = 29.997 -> 29 ; 9_999 * 0.5% = 49.995 -> 49
            expect(await ledger.owed(token, collector)).to.equal(29n)
            expect(await ledger.owed(token, payout)).to.equal(49n)
            expect(await token.balanceOf(recipient)).to.equal(odd - 29n - 49n)
            expect(await ledgerBalance()).to.equal(29n + 49n)
            await deliver(instruction(recipient.address, { feeRate: rate(0.3) }), 1n, 1n)
            expect(await ledger.owed(token, collector)).to.equal(29n)
            expect(await token.balanceOf(recipient)).to.equal(odd - 29n - 49n + 1n)
        })
        it('lets a partner that is also the recipient get the fee back', async () => {
            await deliver(instruction(recipient.address, { feeRate: rate(0.3), partner: recipient.address, partnerRate: rate(0.5) }))
            expect(await ledger.owed(token, recipient)).to.equal(5_000n)
            expect(await token.balanceOf(recipient)).to.equal(amount - 8_000n)
            expect(await ledger.totalOwed(token)).to.equal(8_000n)
        })
        it('accepts a partner with a zero partner rate', async () => {
            await deliver(instruction(recipient.address, { partner: payout.address, partnerRate: 0n }))
            expect(await ledger.owed(token, payout)).to.equal(0n)
            expect(await ledger.owed(token, collector)).to.equal(3_000n)
        })
        it('accepts every mediator on the list', async () => {
            await deliver(instruction(recipient.address), amount, amount, otherMediator)
            expect(await token.balanceOf(recipient)).to.equal(amount - 3_000n)
        })
        it('leaves tokens unaccounted for a rate above its cap', async () => {
            for (const bad of [
                instruction(recipient.address, { feeRate: rate(1.01) }),
                instruction(recipient.address, { feeRate: rate(100) }),
                instruction(recipient.address, withPartner(rate(0.3), rate(1.01))),
            ]) {
                await expect(deliver(bad)).to.emit(ledger, 'Skipped').withArgs(mediator, token, amount, SkipReason.MalformedData)
                expect(await mediator.lastCallbackSucceeded()).to.equal(true)
            }
            expect(await ledger.totalOwed(token)).to.equal(0n)
            expect(await ledgerBalance()).to.equal(amount * 3n)
            expect(await token.balanceOf(recipient)).to.equal(0n)
        })
        it('leaves tokens unaccounted for a partner rate with no partner', async () => {
            await expect(deliver(instruction(recipient.address, { partnerRate: rate(0.1) }))).to.emit(ledger, 'Skipped')
                .withArgs(mediator, token, amount, SkipReason.MalformedData)
            expect(await ledger.totalOwed(token)).to.equal(0n)
        })
        it('leaves tokens unaccounted when data is too short or too long, without reverting', async () => {
            const good = instruction(recipient.address)
            // the old 128 byte layout is too short as well
            const old = coder.encode(['address', 'uint256', 'uint16', 'bool'], [recipient.address, 0n, 30n, false])
            for (const bad of ['0x', good.slice(0, -2), good + '00', good + '00'.repeat(32), old]) {
                await expect(deliver(bad)).to.emit(ledger, 'Skipped')
                expect(await mediator.lastCallbackSucceeded()).to.equal(true)
            }
            expect(await ledger.totalOwed(token)).to.equal(0n)
            expect(await ledgerBalance()).to.equal(amount * 5n)
            expect(await token.balanceOf(recipient)).to.equal(0n)
        })
        it('leaves tokens unaccounted when an address or bool word holds bits its type cannot', async () => {
            const good = instruction(recipient.address, withPartner(rate(0.3), rate(0.5)))
            const word = (index: number) => good.slice(2 + index * 64, 2 + (index + 1) * 64)
            const swap = (index: number, replacement: string) =>
                '0x' + [0, 1, 2, 3, 4].map((at) => (at === index ? replacement : word(at))).join('')
            const dirty = [
                swap(0, 'ff'.repeat(12) + word(0).slice(24)),
                swap(1, '00'.repeat(31) + '02'),
                swap(3, 'ff'.repeat(12) + word(3).slice(24)),
            ]
            for (const bad of dirty) {
                expect(bad.length).to.equal(2 + 320)
                await expect(deliver(bad)).to.emit(ledger, 'Skipped').withArgs(mediator, token, amount, SkipReason.MalformedData)
                expect(await mediator.lastCallbackSucceeded()).to.equal(true)
            }
            expect(await ledger.totalOwed(token)).to.equal(0n)
        })
        it('leaves tokens unaccounted for a zero recipient', async () => {
            await expect(deliver(instruction(ZERO))).to.emit(ledger, 'Skipped')
                .withArgs(mediator, token, amount, SkipReason.ZeroRecipient)
            expect(await ledger.totalOwed(token)).to.equal(0n)
            expect(await ledgerBalance()).to.equal(amount)
            await ledger.rescueUnaccounted(token)
            expect(await token.balanceOf(vault)).to.equal(amount)
        })
        it('uses the available amount when the delivery is short', async () => {
            await deliver(instruction(recipient.address), amount / 2n, amount)
            expect(await ledger.owed(token, collector)).to.equal(1_500n)
            expect(await token.balanceOf(recipient)).to.equal(amount / 2n - 1_500n)
            expect(await ledgerBalance()).to.equal(1_500n)
        })
        it('never pays out of the ledger when nothing was delivered', async () => {
            await deliver(instruction(recipient.address))
            const owedBefore = await ledger.totalOwed(token)
            await expect(deliver(instruction(recipient.address), 0n, amount)).to.emit(ledger, 'Skipped')
                .withArgs(mediator, token, amount, SkipReason.NothingAvailable)
            expect(await ledger.totalOwed(token)).to.equal(owedBefore)
            expect(await ledgerBalance()).to.equal(owedBefore)
        })
        it('credits the recipient when the token transfer returns false', async () => {
            await token.setTransferMode(1, ledger)
            await deliver(instruction(recipient.address))
            expect(await token.balanceOf(recipient)).to.equal(0n)
            expect(await ledger.owed(token, recipient)).to.equal(amount - 3_000n)
            expect(await ledger.totalOwed(token)).to.equal(amount)
            expect(await mediator.lastCallbackSucceeded()).to.equal(true)
        })
        it('credits the recipient when the token transfer reverts', async () => {
            await token.setTransferMode(2, ledger)
            await deliver(instruction(recipient.address))
            expect(await ledger.owed(token, recipient)).to.equal(amount - 3_000n)
            expect(await mediator.lastCallbackSucceeded()).to.equal(true)
        })
        it('does not revert for a delivered token that is not a token', async () => {
            // the mock mediator cannot transfer a non token, so call the ledger as the mediator
            await hre.network.provider.send('hardhat_setBalance', [await mediator.getAddress(), '0x56BC75E2D63100000'])
            await hre.network.provider.request({ method: 'hardhat_impersonateAccount', params: [await mediator.getAddress()] })
            const asMediator = await hre.ethers.getSigner(await mediator.getAddress())
            await expect(ledger.connect(asMediator).onTokenBridged(stranger.address, amount, instruction(recipient.address)))
                .to.emit(ledger, 'Skipped').withArgs(mediator, stranger.address, amount, SkipReason.NothingAvailable)
            await expect(ledger.connect(asMediator).onTokenBridged(ZERO, amount, instruction(recipient.address))).to.emit(ledger, 'Skipped')
            await hre.network.provider.request({ method: 'hardhat_stopImpersonatingAccount', params: [await mediator.getAddress()] })
        })
        it('unwraps to native coin for the recipient', async () => {
            await wNative.deposit({ value: amount })
            await wNative.transfer(mediator, amount)
            const before = await hre.ethers.provider.getBalance(recipient)
            await mediator.deliver(wNative, ledger, amount, amount, instruction(recipient.address, { unwrap: true }))
            expect(await hre.ethers.provider.getBalance(recipient)).to.equal(before + amount - 3_000n)
            expect(await ledger.owed(wNative, collector)).to.equal(3_000n)
            expect(await wNative.balanceOf(ledger)).to.equal(3_000n)
            expect(await hre.ethers.provider.getBalance(ledger)).to.equal(0n)
        })
        it('credits wrapped tokens, not native coin, when the recipient rejects native coin', async () => {
            const rejecting = await (await hre.ethers.getContractFactory('MockPayoutReceiver')).deploy()
            await wNative.deposit({ value: amount })
            await wNative.transfer(mediator, amount)
            await mediator.deliver(wNative, ledger, amount, amount, instruction(await rejecting.getAddress(), { unwrap: true }))
            expect(await mediator.lastCallbackSucceeded()).to.equal(true)
            expect(await ledger.owed(wNative, rejecting)).to.equal(amount - 3_000n)
            expect(await ledger.owed(ZERO, rejecting)).to.equal(0n)
            expect(await wNative.balanceOf(ledger)).to.equal(amount)
            expect(await hre.ethers.provider.getBalance(ledger)).to.equal(0n)
        })
        it('pays wrapped tokens when unwrap is set for another token', async () => {
            await deliver(instruction(recipient.address, { unwrap: true }))
            expect(await token.balanceOf(recipient)).to.equal(amount - 3_000n)
        })
        it('skips instead of reverting on a reentrant delivery', async () => {
            const reentrant = await (await hre.ethers.getContractFactory('MockReentrantMediator')).deploy()
            const guarded = await (await hre.ethers.getContractFactory('HomeFeeLedger')).deploy(
                [mediator, reentrant], wNative, collector, vault,
            )
            await reentrant.setTarget(guarded)
            await wNative.deposit({ value: amount })
            await wNative.transfer(mediator, amount)
            const data = instruction(await reentrant.getAddress(), { unwrap: true })
            await expect(mediator.deliver(wNative, guarded, amount, amount, data))
                .to.emit(guarded, 'Skipped').withArgs(reentrant, reentrant, 1n, SkipReason.Reentrant)
            expect(await reentrant.reentrantCallSucceeded()).to.equal(true)
        })
        it('rejects a caller that is not a mediator', async () => {
            await expect(ledger.connect(stranger).onTokenBridged(token, amount, instruction(recipient.address)))
                .to.be.revertedWithCustomError(ledger, 'NotMediator')
        })
        it('lets a stranger set a fee only on a crossing it sends itself', async () => {
            // a stranger can encode any data, but the tokens only move when a listed mediator delivers
            // them, and the mediator passes the data of that crossing alone
            await deliver(instruction(recipient.address, { feeRate: 0n }))
            await expect(
                ledger.connect(stranger).onTokenBridged(token, amount, instruction(stranger.address, { feeRate: 0n })),
            ).to.be.revertedWithCustomError(ledger, 'NotMediator')
        })
    })

    describe('ledger', () => {
        it('lets each account withdraw its own balance, for tokens', async () => {
            await deliver(instruction(recipient.address, withPartner(rate(0.3), rate(0.5))))
            await expect(ledger.connect(stranger).withdraw(token)).to.be.revertedWithCustomError(ledger, 'NothingToPay')
            await expect(ledger.connect(collector).withdraw(token))
                .to.emit(ledger, 'Withdrawn').withArgs(token, collector.address, collector.address, 3_000n)
            expect(await token.balanceOf(collector)).to.equal(3_000n)
            expect(await ledger.totalOwed(token)).to.equal(5_000n)
            await ledger.connect(payout).withdrawTo(token, stranger)
            expect(await token.balanceOf(stranger)).to.equal(5_000n)
            expect(await ledger.totalOwed(token)).to.equal(0n)
            await expect(ledger.connect(payout).withdraw(token)).to.be.revertedWithCustomError(ledger, 'NothingToPay')
            await expect(ledger.connect(payout).withdrawTo(token, ZERO)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
        })
        it('lets a failed recipient withdraw what was credited', async () => {
            await token.setTransferMode(1, ledger)
            await deliver(instruction(recipient.address))
            await token.setTransferMode(0, ZERO)
            await ledger.connect(recipient).withdraw(token)
            expect(await token.balanceOf(recipient)).to.equal(amount - 3_000n)
        })
        it('rescues only what is not owed', async () => {
            await deliver(instruction(recipient.address))
            await expect(ledger.rescueUnaccounted(token)).to.be.revertedWithCustomError(ledger, 'NothingToPay')
            await token.mint(ledger, 777n)
            await ledger.rescueUnaccounted(token)
            expect(await token.balanceOf(vault)).to.equal(777n)
            expect(await ledgerBalance()).to.equal(3_000n)
            expect(await ledger.owed(token, collector)).to.equal(3_000n)
            expect(await ledger.totalOwed(token)).to.equal(3_000n)
            await expect(ledger.rescueUnaccounted(token)).to.be.revertedWithCustomError(ledger, 'NothingToPay')
            await ledger.connect(collector).withdraw(token)
            expect(await token.balanceOf(collector)).to.equal(3_000n)
        })
        it('pays the fixed rescue recipient whoever calls, and nobody else', async () => {
            await token.mint(ledger, 500n)
            const callers = [stranger, owner, collector]
            for (const caller of callers) {
                await token.mint(ledger, 100n)
                const before = await Promise.all([caller, recipient, owner, stranger, collector].map((who) => token.balanceOf(who)))
                await expect(ledger.connect(caller).rescueUnaccounted(token))
                    .to.emit(ledger, 'Rescued').withArgs(token, vault.address, caller === stranger ? 600n : 100n)
                const after = await Promise.all([caller, recipient, owner, stranger, collector].map((who) => token.balanceOf(who)))
                expect(after).to.deep.equal(before)
            }
            expect(await token.balanceOf(vault)).to.equal(800n)
            expect(await ledgerBalance()).to.equal(0n)
        })
        it('has no rescue form that takes a destination', async () => {
            const rescues = ledger.interface.fragments.filter((fragment: any) => fragment.name === 'rescueUnaccounted')
            expect(rescues.length).to.equal(1)
            expect(rescues[0].inputs.map((input: any) => input.type)).to.deep.equal(['address'])
            expect(rescues[0].inputs[0].name).to.equal('token')
        })
        it('cannot rescue credited fees, even after a partial delivery', async () => {
            await deliver(instruction(recipient.address, withPartner(rate(0.3), rate(0.5))))
            await deliver(instruction(recipient.address), amount / 2n, amount)
            const owedBefore = await ledger.totalOwed(token)
            expect(owedBefore).to.equal(8_000n + 1_500n)
            await expect(ledger.rescueUnaccounted(token)).to.be.revertedWithCustomError(ledger, 'NothingToPay')
            await token.mint(ledger, 1n)
            await expect(ledger.rescueUnaccounted(token)).to.emit(ledger, 'Rescued').withArgs(token, vault.address, 1n)
            expect(await ledger.totalOwed(token)).to.equal(owedBefore)
            expect(await ledgerBalance()).to.equal(owedBefore)
        })
        it('refuses native coin from anyone but the wrapped token', async () => {
            await expect(stranger.sendTransaction({ to: ledger, value: 1n })).to.be.revertedWithCustomError(ledger, 'SenderNotWrappedNative')
        })
        it('rescues native coin that arrived by force, and nothing else', async () => {
            await hre.network.provider.send('hardhat_setBalance', [await ledger.getAddress(), '0x64'])
            await expect(ledger.rescueUnaccounted(ZERO)).to.changeEtherBalances([ledger, vault], [-100n, 100n])
            await expect(ledger.rescueUnaccounted(ZERO)).to.be.revertedWithCustomError(ledger, 'NothingToPay')
        })
        it('withdraws a native entry with a call', async () => {
            // no code path credits native coin today, so plant owed (slot 2) and totalOwed (slot 3) entries
            const owedSlot = ethers.keccak256(coder.encode(['address', 'bytes32'], [user.address,
                ethers.keccak256(coder.encode(['address', 'uint256'], [ZERO, 2]))]))
            const totalSlot = ethers.keccak256(coder.encode(['address', 'uint256'], [ZERO, 3]))
            const word = ethers.zeroPadValue('0x64', 32)
            await hre.network.provider.send('hardhat_setStorageAt', [await ledger.getAddress(), owedSlot, word])
            await hre.network.provider.send('hardhat_setStorageAt', [await ledger.getAddress(), totalSlot, word])
            await hre.network.provider.send('hardhat_setBalance', [await ledger.getAddress(), '0x64'])
            expect(await ledger.owed(ZERO, user)).to.equal(100n)
            await expect(ledger.connect(user).withdrawTo(ZERO, stranger)).to.changeEtherBalance(stranger, 100n)
            expect(await ledger.totalOwed(ZERO)).to.equal(0n)
        })
    })

    describe('outbound', () => {
        const toForeign = ethers.getAddress('0x00000000000000000000000000000000000000aa')
        const terms = (feeRate: bigint, partnerRate = 0n, partner = ZERO) => ({
            feeRateE18: feeRate,
            partner,
            partnerRateE18: partnerRate,
        })
        beforeEach(async () => {
            await token.mint(user, amount * 10n)
            await token.connect(user).approve(ledger, ethers.MaxUint256)
        })

        it('takes the named fees and bridges the rest with data unchanged', async () => {
            const data = '0x1234abcd'
            const pending = ledger.connect(user).relay(mediator, token, amount, toForeign, data, terms(rate(0.3), rate(0.5), payout.address))
            await expect(pending)
                .to.emit(mediator, 'TokensBridgingInitiated')
                .withArgs(token, ledger, amount - 8_000n, toForeign, data)
            const receipt = await (await pending).wait()
            console.log(`      outbound relay with partner, gas: ${receipt.gasUsed}`)
            expect(await token.balanceOf(mediator)).to.equal(amount - 8_000n)
            expect(await ledger.owed(token, collector)).to.equal(3_000n)
            expect(await ledger.owed(token, payout)).to.equal(5_000n)
            expect(await ledgerBalance()).to.equal(8_000n)
            expect(await token.allowance(ledger, mediator)).to.equal(0n)
        })
        it('measures the amount received for a fee-on-transfer token', async () => {
            await token.setFeeBasisPoints(100) // 1% burnt on every transfer
            // user -> ledger: 990_000 arrives. fee 0.3% of that = 2_970. The mediator then pulls the rest.
            await ledger.connect(user).relay(mediator, token, amount, toForeign, '0x', terms(rate(0.3)))
            const events = await helpers.getEvents(mediator, 'TokensBridgingInitiated')
            expect(events[0].args.value).to.equal(990_000n - 2_970n)
            expect(await ledger.owed(token, collector)).to.equal(2_970n)
            expect(await ledger.totalOwed(token)).to.equal(2_970n)
        })
        it('reverts for a rate above its cap or a partner rate with no partner', async () => {
            await expect(ledger.connect(user).relay(mediator, token, amount, toForeign, '0x', terms(rate(1.01))))
                .to.be.revertedWithCustomError(ledger, 'InvalidFees')
            await expect(ledger.connect(user).relay(mediator, token, amount, toForeign, '0x', terms(rate(0.3), rate(1.01), payout.address)))
                .to.be.revertedWithCustomError(ledger, 'InvalidFees')
            await expect(ledger.connect(user).relay(mediator, token, amount, toForeign, '0x', terms(rate(0.3), rate(0.01))))
                .to.be.revertedWithCustomError(ledger, 'InvalidFees')
        })
        it('reverts for a mediator that is not on the list', async () => {
            await expect(ledger.connect(user).relay(stranger, token, amount, toForeign, '0x', terms(rate(0.3))))
                .to.be.revertedWithCustomError(ledger, 'NotMediator')
            await expect(ledger.connect(user).relayNative(stranger, toForeign, '0x', terms(rate(0.3)), { value: amount }))
                .to.be.revertedWithCustomError(ledger, 'NotMediator')
        })
        it('reverts when nothing is received', async () => {
            await expect(ledger.connect(user).relay(mediator, token, 0, toForeign, '0x', terms(rate(0.3))))
                .to.be.revertedWithCustomError(ledger, 'NothingReceived')
        })
        it('wraps native coin and bridges the rest', async () => {
            await expect(ledger.connect(user).relayNative(mediator, toForeign, '0xbeef', terms(rate(0.3), rate(0.5), payout.address), { value: amount }))
                .to.emit(mediator, 'TokensBridgingInitiated')
                .withArgs(wNative, ledger, amount - 8_000n, toForeign, '0xbeef')
            expect(await wNative.balanceOf(mediator)).to.equal(amount - 8_000n)
            expect(await ledger.owed(wNative, collector)).to.equal(3_000n)
            expect(await ledger.owed(wNative, payout)).to.equal(5_000n)
            expect(await hre.ethers.provider.getBalance(ledger)).to.equal(0n)
        })
    })
})
