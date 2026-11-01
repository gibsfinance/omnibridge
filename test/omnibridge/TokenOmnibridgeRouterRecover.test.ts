import hre from 'hardhat'
import { loadFixture, takeSnapshot } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import * as ethers from 'ethers'
import * as helpers from '../helpers/helpers'
import * as setup from '../setup'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'

const oneEther = ethers.parseEther('1')
const value = oneEther / 10n
const unwrapFlag = 0b0010n
const coder = ethers.AbiCoder.defaultAbiCoder()

/**
 * Packs signatures in the bridge blob layout: one count byte, the v bytes, the r words, the s words.
 * The shared helpers.packSignatures cannot be used here: it hex-encodes the count with a string that
 * is not valid hexadecimal for counts below ten, so it throws for the two-signature case.
 */
const packSignatures = (pieces: Array<{ v: string; r: string; s: string }>) =>
    '0x' +
    pieces.length.toString(16).padStart(2, '0') +
    pieces.map((piece) => piece.v).join('') +
    pieces.map((piece) => piece.r).join('') +
    pieces.map((piece) => piece.s).join('')

/** Encodes the fee director struct the router decodes from the callback data. */
const feeDirector = (recipient: string, settings: bigint, limit = 0n, multiplier = 0n) =>
    coder.encode(['address', 'uint256', 'uint256', 'uint256'], [recipient, settings, limit, multiplier])

describe('TokenOmnibridgeRouter recovery and wrapped fallback', () => {
    let signers!: HardhatEthersSigner[]
    let owner!: HardhatEthersSigner
    let user!: HardhatEthersSigner
    let stranger!: HardhatEthersSigner
    let validators!: ethers.HDNodeWallet[]
    let outsider!: ethers.HDNodeWallet
    let token!: any
    let mediator!: any
    let amb!: any
    let router!: any
    let factoryForRouter!: any
    let messageCounter = 0

    const deployContracts = async () => {
        signers = await hre.ethers.getSigners()
        owner = signers[0]
        user = signers[1]
        stranger = signers[2]
        validators = [0, 1, 2].map(() => ethers.Wallet.createRandom())
        outsider = ethers.Wallet.createRandom()
        const PermittableToken = await setup.requirePrecompiled('PermittableToken')
        const ForeignOmnibridge = await hre.ethers.getContractFactory('ForeignOmnibridge')
        factoryForRouter = await hre.ethers.getContractFactory('TokenOmnibridgeRouter')
        const AMBMock = await hre.ethers.getContractFactory('AMBMock')
        const WETH = await hre.ethers.getContractFactory('WETH')
        const TokenFactory = await hre.ethers.getContractFactory('TokenFactory')
        const tokenImage = await PermittableToken.deploy('TEST', 'TST', 18, 1337)
        const tokenFactory = await TokenFactory.deploy(owner, tokenImage)
        mediator = await ForeignOmnibridge.deploy(' on Testnet')
        const BridgeValidators = await hre.ethers.getContractFactory('BridgeValidators')
        const bridgeValidators = await BridgeValidators.deploy()
        // two signatures are required out of three validators
        await bridgeValidators.initialize(2, validators.map((wallet) => wallet.address), owner)
        amb = await AMBMock.deploy(bridgeValidators)
        await mediator.initialize(
            amb,
            mediator,
            [oneEther * 100n, oneEther * 10n, 1n],
            [oneEther * 100n, oneEther * 10n],
            1000000,
            owner,
            tokenFactory,
        )
        token = await WETH.deploy()
        router = await factoryForRouter.deploy(mediator, token, owner)
        // put custody in the mediator the way a real outbound transfer would
        await router.connect(user).getFunction('wrapAndRelayTokens()')({ value: oneEther })
    }

    beforeEach(async () => {
        await loadFixture(deployContracts)
    })

    /** Builds a message in the Arbitrary Message Bridge layout. */
    const buildMessage = (options: {
        messageId: string
        executor: string
        innerCall: string
        sender?: string
    }) =>
        ethers.concat([
            options.messageId,
            options.sender ?? (mediator.target as string),
            options.executor,
            ethers.toBeHex(2_000_000, 4),
            '0x02', // source chain id length
            '0x01', // destination chain id length
            '0x00', // data type
            '0x0171', // source chain id: 369
            '0x01', // destination chain id: 1
            options.innerCall,
        ])

    const nextMessageId = () => ethers.keccak256(ethers.toUtf8Bytes(`recover-test-${messageCounter++}`))

    const handleCall = (options: { recipient?: string; amount?: bigint; data: string; selector?: string }) => {
        const encoded = coder.encode(
            ['address', 'address', 'uint256', 'bytes'],
            [token.target, options.recipient ?? router.target, options.amount ?? value, options.data],
        )
        const selector =
            options.selector ?? mediator.interface.getFunction('handleNativeTokensAndCall')!.selector
        return ethers.concat([selector, encoded])
    }

    const sign = async (message: string, signerWallets: ethers.HDNodeWallet[]) => {
        const pieces = []
        for (const wallet of signerWallets) {
            pieces.push(helpers.signatureToVRS(await wallet.signMessage(ethers.getBytes(message))))
        }
        return packSignatures(pieces)
    }

    const deliver = (messageId: string, innerCall: string, gas: bigint) =>
        amb.executeMessageCall(mediator, mediator, innerCall, messageId, gas, { gasLimit: 8_000_000n })

    /**
     * Finds a gas budget where the mediator succeeds but the router callback runs out of gas.
     * A strand is the router's holding of `asset` growing by exactly `amount` while the bridge
     * records the mediator call as successful. Defaults: the wrapped token and the test value.
     */
    const strand = async (
        messageId: string,
        innerCall: string,
        options: { asset?: any; amount?: bigint; maximumGas?: bigint } = {},
    ) => {
        const asset = options.asset ?? token
        const amount = options.amount ?? value
        const holdingBefore: bigint = await asset.balanceOf(router)
        for (let gas = 60_000n; gas < (options.maximumGas ?? 700_000n); gas += 2_000n) {
            const snapshot = await takeSnapshot()
            await deliver(messageId, innerCall, gas)
            const stranded = (await asset.balanceOf(router)) - holdingBefore === amount
            const mediatorReportedSuccess = await amb.messageCallStatus(messageId)
            if (stranded && mediatorReportedSuccess) return gas
            await snapshot.restore()
        }
        throw new Error('no gas budget produced a strand')
    }

    describe('wrapped token fallback in onTokenBridged', () => {
        let stubMediator!: HardhatEthersSigner
        let stubRouter!: any

        beforeEach(async () => {
            stubMediator = signers[5]
            stubRouter = await factoryForRouter.deploy(stubMediator, token, owner)
            await token.deposit({ value })
            await token.transfer(stubRouter, value)
        })

        it('delivers the wrapped token when the recipient refuses native coin', async () => {
            const Refuser = await hre.ethers.getContractFactory('MockPayoutReceiver')
            const refuser = await Refuser.deploy() // refuses native coin by default
            const nativeBefore = await hre.ethers.provider.getBalance(refuser)
            const wrappedBefore = await token.balanceOf(refuser)
            await expect(
                stubRouter.connect(stubMediator).onTokenBridged(token, value, feeDirector(await refuser.getAddress(), unwrapFlag)),
            ).to.not.be.reverted
            expect(await token.balanceOf(refuser)).to.equal(wrappedBefore + value)
            expect(await hre.ethers.provider.getBalance(refuser)).to.equal(nativeBefore)
            expect(await token.balanceOf(stubRouter)).to.equal(0n)
            expect(await hre.ethers.provider.getBalance(stubRouter)).to.equal(0n)
        })

        it('still pays native coin to a recipient that accepts it', async () => {
            const Accepter = await hre.ethers.getContractFactory('MockPayoutReceiver')
            const accepter = await Accepter.deploy()
            await accepter.setAccepting(true)
            await stubRouter.connect(stubMediator).onTokenBridged(token, value, feeDirector(await accepter.getAddress(), unwrapFlag))
            expect(await hre.ethers.provider.getBalance(accepter)).to.equal(value)
            expect(await token.balanceOf(accepter)).to.equal(0n)
        })
    })

    describe('recover', () => {
        const unwrapData = () => feeDirector(stranger.address, unwrapFlag)

        const makeStrand = async () => {
            const messageId = nextMessageId()
            const innerCall = handleCall({ data: unwrapData() })
            await strand(messageId, innerCall)
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            return { messageId, innerCall, message }
        }

        it('pays the full value with no fee and records the message', async () => {
            const { messageId, message } = await makeStrand()
            // the strand is real: tokens sit in the router, the recipient has nothing, the bridge says delivered
            expect(await token.balanceOf(router)).to.equal(value)
            expect(await amb.messageCallStatus(messageId)).to.equal(true)
            expect(await router.processed(messageId)).to.equal(false)

            const signatures = await sign(message, [validators[0], validators[1]])
            const before = await hre.ethers.provider.getBalance(stranger)
            await expect(router.connect(user).recover(message, signatures))
                .to.emit(router, 'DeliveryRecovered')
                .withArgs(messageId, token.target, router.target, value)
            expect(await hre.ethers.provider.getBalance(stranger)).to.equal(before + value)
            expect(await token.balanceOf(router)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(true)
        })

        it('reverts AlreadyProcessed on a second recover of the same message', async () => {
            const { message } = await makeStrand()
            const signatures = await sign(message, [validators[0], validators[1]])
            await router.recover(message, signatures)
            await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'AlreadyProcessed')
        })

        it('reverts AlreadyProcessed on a message the normal path already delivered', async () => {
            const messageId = nextMessageId()
            const innerCall = handleCall({ data: unwrapData() })
            const before = await hre.ethers.provider.getBalance(stranger)
            await deliver(messageId, innerCall, 3_000_000n)
            // the normal delivery really paid, so the guard is the only thing standing in the way
            expect(await hre.ethers.provider.getBalance(stranger)).to.equal(before + value)
            expect(await router.processed(messageId)).to.equal(true)
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])
            await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'AlreadyProcessed')
        })

        describe('rejections', () => {
            it('NotForThisRouter when the recipient is another address', async () => {
                const messageId = nextMessageId()
                const innerCall = handleCall({ recipient: stranger.address, data: unwrapData() })
                await deliver(messageId, innerCall, 3_000_000n)
                // this message was relayed and succeeded, so only the recipient check can stop it
                // (processed is false because the router was not the recipient)
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
                const signatures = await sign(message, [validators[0], validators[1]])
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'NotForThisRouter')
            })

            it('UnsupportedSelector for a selector that is not a handle call', async () => {
                const messageId = nextMessageId()
                const innerCall = handleCall({
                    data: unwrapData(),
                    selector: mediator.interface.getFunction('handleNativeTokens')!.selector,
                })
                // any call that succeeds marks the message relayed and delivered
                await amb.executeMessageCall(token, router, token.interface.encodeFunctionData('deposit'), messageId, 100_000n)
                expect(await amb.messageCallStatus(messageId)).to.equal(true)
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
                const signatures = await sign(message, [validators[0], validators[1]])
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'UnsupportedSelector')
            })

            it('WrongExecutor when the message is not for this mediator', async () => {
                const messageId = nextMessageId()
                const innerCall = handleCall({ data: unwrapData() })
                const message = buildMessage({ messageId, executor: stranger.address, innerCall })
                const signatures = await sign(message, [validators[0], validators[1]])
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'WrongExecutor')
            })

            it('NotEnoughSignatures below the required count', async () => {
                const { message } = await makeStrand()
                const signatures = await sign(message, [validators[0]])
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'NotEnoughSignatures')
            })

            it('SignerNotValidator when a signer is not in the validator set', async () => {
                const { message } = await makeStrand()
                const signatures = await sign(message, [validators[0], outsider])
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'SignerNotValidator')
            })

            it('DuplicateSignature when one validator signs twice', async () => {
                const { message } = await makeStrand()
                const signatures = await sign(message, [validators[0], validators[0]])
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'DuplicateSignature')
            })

            it('SignerNotValidator when valid signatures cover a different message', async () => {
                const { message } = await makeStrand()
                const other = ethers.concat([message, '0x00'])
                const signatures = await sign(other, [validators[0], validators[1]])
                // the recovered signer for the altered hash is a random address, not a validator
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'SignerNotValidator')
            })

            it('MessageNotRelayed when the bridge never relayed the message', async () => {
                const messageId = nextMessageId()
                const innerCall = handleCall({ data: unwrapData() })
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
                const signatures = await sign(message, [validators[0], validators[1]])
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'MessageNotRelayed')
            })

            it('MessageNotDelivered when the relayed message failed', async () => {
                const messageId = nextMessageId()
                const innerCall = handleCall({ data: unwrapData() })
                // far too little gas: the mediator call itself fails, so the bridge records status false
                await amb.executeMessageCall(mediator, mediator, innerCall, messageId, 30_000n, { gasLimit: 8_000_000n })
                expect(await amb.relayedMessages(messageId)).to.equal(true)
                expect(await amb.messageCallStatus(messageId)).to.equal(false)
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
                const signatures = await sign(message, [validators[0], validators[1]])
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'MessageNotDelivered')
            })
        })
    })

    // The full lifecycle through the one function a deliverer calls. Assertions use
    // plain state and balance reads (not the chai revert/emit matchers) so the test
    // behaves identically on the in-process network and on an anvil node.
    describe('full lifecycle through the single delivery entry', () => {
        it('insufficient gas strands the transfer; re-running the same message through the single entry delivers it in full, once', async () => {
            const messageId = nextMessageId()
            // unwrap-to-native delivery whose end recipient is `stranger`
            const innerCall = handleCall({ data: feeDirector(stranger.address, unwrapFlag) })
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])

            // 1) deliver through the gas-limited path with INSUFFICIENT gas. strand() performs
            //    the actual low-gas delivery (the mediator reports success, the router callback
            //    runs out of gas) and leaves that stranded state in place.
            await strand(messageId, innerCall)
            expect(await token.balanceOf(router)).to.equal(value) // tokens stuck in the router
            expect(await amb.relayedMessages(messageId)).to.equal(true) // bridge marked it relayed
            expect(await amb.messageCallStatus(messageId)).to.equal(true) // mediator swallowed the failure, reported success
            expect(await router.processed(messageId)).to.equal(false) // our flag was never set (the reverted frame rolled it back)
            const recipientBefore = await hre.ethers.provider.getBalance(stranger)
            expect(recipientBefore).to.equal(await hre.ethers.provider.getBalance(stranger)) // sanity: recipient unpaid so far

            // 2) re-run the SAME message through the SINGLE ENTRY with ample gas. relayedMessages is
            //    true, so the entry routes to recovery (no tip). runner is ignored on this branch.
            await router.connect(user).safeExecuteSignaturesWithAutoGasLimit(user.address, message, signatures)

            // 3) delivered correctly: the recipient got the full value as native coin, the router is
            //    empty, and the message is now recorded.
            expect((await hre.ethers.provider.getBalance(stranger)) - recipientBefore).to.equal(value)
            expect(await token.balanceOf(router)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(true)

            // 4) the same message a third time pays nothing: the entry hits AlreadyProcessed and reverts.
            const recipientAfter = await hre.ethers.provider.getBalance(stranger)
            let reverted = false
            try {
                await router.connect(user).safeExecuteSignaturesWithAutoGasLimit.staticCall(user.address, message, signatures)
            } catch {
                reverted = true
            }
            expect(reverted).to.equal(true)
            expect(await hre.ethers.provider.getBalance(stranger)).to.equal(recipientAfter) // no double payment
        })

        it('sufficient gas on the first delivery pays the recipient directly, no recovery needed', async () => {
            const messageId = nextMessageId()
            const innerCall = handleCall({ data: feeDirector(stranger.address, unwrapFlag) })
            const before = await hre.ethers.provider.getBalance(stranger)
            // ample gas: the router callback completes inside the delivery
            await deliver(messageId, innerCall, 3_000_000n)
            expect((await hre.ethers.provider.getBalance(stranger)) - before).to.equal(value)
            expect(await token.balanceOf(router)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(true)
        })

        it('a validator runner that recovers a strand through the single entry earns the tip', async () => {
            // this is what gives a relayer a reason to finish a stranded delivery,
            // so a griefer who strands a transfer cannot deny the service.
            const runner = signers[4]
            const caller = signers[5]
            await router.connect(owner).setValidatorStatus(runner.address, true)

            const messageId = nextMessageId()
            const fee = value / 10n
            // fixed-fee token delivery (no unwrap): recipient = user, fee = value/10
            const innerCall = handleCall({ data: feeDirector(user.address, 0b0001n, fee) })
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])

            await strand(messageId, innerCall)
            expect(await token.balanceOf(router)).to.equal(value)
            expect(await router.processed(messageId)).to.equal(false)

            const recipientBefore = await token.balanceOf(user)
            const runnerBefore = await token.balanceOf(runner.address)
            // the validator runner is attributed; the caller can be anyone
            await router.connect(caller).safeExecuteSignaturesWithAutoGasLimit(runner.address, message, signatures)

            expect((await token.balanceOf(user)) - recipientBefore).to.equal(value - fee) // recipient gets value minus the tip
            expect((await token.balanceOf(runner.address)) - runnerBefore).to.equal(fee) // runner earns the tip
            expect(await token.balanceOf(router)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(true)
        })

        it('a non-validator recovering through the single entry earns no tip (recipient paid in full)', async () => {
            const runner = signers[6] // not a validator
            const messageId = nextMessageId()
            const innerCall = handleCall({ data: feeDirector(user.address, 0b0001n, value / 10n) })
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])

            await strand(messageId, innerCall)
            const recipientBefore = await token.balanceOf(user)
            const runnerBefore = await token.balanceOf(runner.address)
            await router.connect(runner).safeExecuteSignaturesWithAutoGasLimit(runner.address, message, signatures)

            expect((await token.balanceOf(user)) - recipientBefore).to.equal(value) // full value, no tip taken
            expect(await token.balanceOf(runner.address)).to.equal(runnerBefore) // non-validator earns nothing
            expect(await router.processed(messageId)).to.equal(true)
        })
    })

    // A handleBridgedTokensAndCall message names the token's address on the OTHER chain. The
    // mediator mints its own bridged token, found with bridgedTokenAddress(messageToken). PulseChain
    // copied Ethereum's state, so PulseChain's copy of WETH has the same address as the real WETH
    // here. These tests build exactly that: the message token is the local wrapped token's address,
    // and the mediator mints a DIFFERENT bridged token for it.
    describe('recovery of a bridged token resolves the local token', () => {
        const erc20 = ['function balanceOf(address) view returns (uint256)']
        let bridged!: ethers.Contract
        let attacker!: HardhatEthersSigner
        let victim!: HardhatEthersSigner

        const bridgedCall = (data: string, amount = value) =>
            ethers.concat([
                mediator.interface.getFunction('handleBridgedTokensAndCall')!.selector,
                coder.encode(['address', 'address', 'uint256', 'bytes'], [token.target, router.target, amount, data]),
            ])

        /** Strands a real wrapped-token delivery from an honest user, so the router holds other people's funds. */
        const strandHonestWrappedDelivery = async () => {
            const messageId = nextMessageId()
            const innerCall = handleCall({ data: feeDirector(victim.address, 0n) })
            await strand(messageId, innerCall)
            return { messageId, message: buildMessage({ messageId, executor: mediator.target as string, innerCall }) }
        }

        beforeEach(async () => {
            attacker = signers[7]
            victim = signers[8]
            // First transfer of the other chain's "WETH" registers the pair and deploys the bridged token.
            const registration = mediator.interface.encodeFunctionData('deployAndHandleBridgedTokens', [
                token.target,
                'Wrapped Ether',
                'WETH',
                18,
                owner.address,
                1n,
            ])
            await deliver(nextMessageId(), registration, 3_000_000n)
            const bridgedAddress: string = await mediator.bridgedTokenAddress(token.target)
            expect(bridgedAddress).to.not.equal(ethers.ZeroAddress)
            expect(bridgedAddress).to.not.equal(token.target)
            bridged = new ethers.Contract(bridgedAddress, erc20, hre.ethers.provider)
        })

        it('pays the bridged token the mediator minted, not the token named in the message', async () => {
            await strandHonestWrappedDelivery()
            expect(await token.balanceOf(router)).to.equal(value)

            const messageId = nextMessageId()
            const innerCall = bridgedCall(feeDirector(user.address, 0n))
            await strand(messageId, innerCall, { asset: bridged })
            expect(await bridged.balanceOf(router)).to.equal(value)

            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])
            const wrappedBefore = await token.balanceOf(user)
            await expect(router.connect(user).recover(message, signatures))
                .to.emit(router, 'DeliveryRecovered')
                .withArgs(messageId, bridged.target, router.target, value)
            expect(await bridged.balanceOf(user)).to.equal(value)
            expect(await token.balanceOf(user)).to.equal(wrappedBefore)
            expect(await bridged.balanceOf(router)).to.equal(0n)
            // the honest user's stranded wrapped token is untouched
            expect(await token.balanceOf(router)).to.equal(value)
        })

        it('refuses the attack: a rejected bridged delivery cannot unwrap other users\' wrapped token', async () => {
            const honest = await strandHonestWrappedDelivery()
            // The 20-byte legacy form demands the wrapped token. The mediator hands the router the
            // bridged token, so the callback rejects it at any gas and the delivery strands.
            const messageId = nextMessageId()
            const innerCall = bridgedCall(attacker.address)
            await deliver(messageId, innerCall, 3_000_000n)
            expect(await amb.messageCallStatus(messageId)).to.equal(true)
            expect(await bridged.balanceOf(router)).to.equal(value)
            expect(await token.balanceOf(router)).to.equal(value)

            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])
            const attackerNativeBefore = await hre.ethers.provider.getBalance(attacker)
            const attackerWrappedBefore = await token.balanceOf(attacker)
            await expect(router.connect(stranger).recover(message, signatures)).to.be.reverted
            expect(await hre.ethers.provider.getBalance(attacker)).to.equal(attackerNativeBefore)
            expect(await token.balanceOf(attacker)).to.equal(attackerWrappedBefore)
            expect(await token.balanceOf(router)).to.equal(value)
            expect(await router.processed(messageId)).to.equal(false)

            // the honest strand is still whole and still recoverable
            const honestSignatures = await sign(honest.message, [validators[0], validators[1]])
            await router.connect(stranger).recover(honest.message, honestSignatures)
            expect(await token.balanceOf(victim)).to.equal(value)
            expect(await token.balanceOf(router)).to.equal(0n)
        })

        it('reverts UnknownBridgedToken when the mediator has no bridged token for the message token', async () => {
            await strandHonestWrappedDelivery()
            const messageId = nextMessageId()
            const unknownToken = ethers.Wallet.createRandom().address
            const innerCall = ethers.concat([
                mediator.interface.getFunction('handleBridgedTokensAndCall')!.selector,
                coder.encode(['address', 'address', 'uint256', 'bytes'], [unknownToken, router.target, value, feeDirector(user.address, 0n)]),
            ])
            // any call that succeeds marks the message relayed and delivered
            await amb.executeMessageCall(token, router, token.interface.encodeFunctionData('deposit'), messageId, 100_000n)
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])
            await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'UnknownBridgedToken')
            expect(await token.balanceOf(router)).to.equal(value)
        })
    })

    // The router holds every user's strands of a token in one balance. Recovery must never pay one
    // message out of another's funds by quietly paying less, and must never close a message it
    // could not pay in full.
    describe('recovery from a shared balance', () => {
        /**
         * Puts `arrived` of the wrapped token in the router for a message that says `messageValue`, and
         * marks the message relayed and delivered. This is a strand whose token arrived short, as a
         * fee-on-transfer token does.
         */
        const strandThatArrived = async (arrived: bigint, messageValue: bigint, recipient: string) => {
            const messageId = nextMessageId()
            const innerCall = handleCall({ amount: messageValue, data: feeDirector(recipient, 0n) })
            await token.deposit({ value: arrived })
            await token.transfer(router, arrived)
            await amb.executeMessageCall(token, router, token.interface.encodeFunctionData('deposit'), messageId, 100_000n)
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            return { messageId, message, signatures: await sign(message, [validators[0], validators[1]]) }
        }

        it('two strands of one token: a short balance reverts and leaves the message claimable', async () => {
            const firstRecipient = signers[7]
            const secondRecipient = signers[8]
            const shortfall = value / 4n
            const first = await strandThatArrived(value, value, firstRecipient.address)
            const second = await strandThatArrived(value - shortfall, value, secondRecipient.address)
            expect(await token.balanceOf(router)).to.equal(2n * value - shortfall)

            await router.recover(first.message, first.signatures)
            expect(await token.balanceOf(firstRecipient)).to.equal(value)
            expect(await token.balanceOf(router)).to.equal(value - shortfall)

            // the second message is owed `value` but only `value - shortfall` is left
            await expect(router.recover(second.message, second.signatures))
                .to.be.revertedWithCustomError(router, 'InsufficientBalanceForRecovery')
                .withArgs(token.target, value - shortfall, value)
            expect(await token.balanceOf(secondRecipient)).to.equal(0n)
            expect(await router.processed(second.messageId)).to.equal(false)

            // once the balance covers it, the same message recovers in full
            await token.deposit({ value: shortfall })
            await token.transfer(router, shortfall)
            await router.recover(second.message, second.signatures)
            expect(await token.balanceOf(secondRecipient)).to.equal(value)
            expect(await token.balanceOf(router)).to.equal(0n)
            expect(await router.processed(second.messageId)).to.equal(true)
        })

        it('an empty balance reverts instead of paying nothing and closing the message', async () => {
            const recipient = signers[7]
            const empty = await strandThatArrived(0n, value, recipient.address)
            await expect(router.recover(empty.message, empty.signatures))
                .to.be.revertedWithCustomError(router, 'InsufficientBalanceForRecovery')
                .withArgs(token.target, 0n, value)
            expect(await router.processed(empty.messageId)).to.equal(false)
        })
    })

    // The single delivery entry holds the runner slot, not the reentrancy guard that recover() holds.
    // A payout recipient that re-enters recover() for ANOTHER strand would then run that recovery
    // with the outer runner still attributed, and pay the outer runner a tip it did not earn.
    describe('re-entry during a recovery through the single delivery entry', () => {
        it('a recipient cannot re-enter recover() and tip the outer runner from another strand', async () => {
            const runner = signers[4]
            const secondRecipient = signers[8]
            await router.connect(owner).setValidatorStatus(runner.address, true)
            const hookToken = await (await hre.ethers.getContractFactory('MockTransferHookToken')).deploy()
            const recoverer = await (await hre.ethers.getContractFactory('MockReentrantRecoverer')).deploy()
            const tip = value / 10n

            /** Strands `value` of the hook token for a fixed-tip delivery to `recipient`. */
            const strandHookToken = async (recipient: string) => {
                const messageId = nextMessageId()
                const innerCall = ethers.concat([
                    mediator.interface.getFunction('handleNativeTokensAndCall')!.selector,
                    coder.encode(['address', 'address', 'uint256', 'bytes'], [hookToken.target, router.target, value, feeDirector(recipient, 0b0001n, tip)]),
                ])
                await hookToken.mint(router, value)
                await amb.executeMessageCall(token, router, token.interface.encodeFunctionData('deposit'), messageId, 100_000n)
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
                return { messageId, message, signatures: await sign(message, [validators[0], validators[1]]) }
            }

            const outer = await strandHookToken(await recoverer.getAddress())
            const inner = await strandHookToken(secondRecipient.address)
            await recoverer.arm(router, inner.message, inner.signatures)

            await router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit(runner.address, outer.message, outer.signatures)

            // the outer message paid as it should
            expect(await hookToken.balanceOf(recoverer)).to.equal(value - tip)
            expect(await router.processed(outer.messageId)).to.equal(true)
            // the re-entrant recovery was attempted and refused by the reentrancy guard
            expect(await recoverer.reentrantCallMade()).to.equal(true)
            expect(await recoverer.reentrantCallSucceeded()).to.equal(false)
            expect(await recoverer.reentrantCallRevertData()).to.equal(router.interface.getError('ReentrancyGuard')!.selector)
            // so the runner earned exactly one tip, and the other strand is untouched
            expect(await hookToken.balanceOf(runner)).to.equal(tip)
            expect(await hookToken.balanceOf(secondRecipient)).to.equal(0n)
            expect(await router.processed(inner.messageId)).to.equal(false)
            expect(await hookToken.balanceOf(router)).to.equal(value)

            // the other strand still recovers on its own, with no tip because no runner is attributed
            await router.recover(inner.message, inner.signatures)
            expect(await hookToken.balanceOf(secondRecipient)).to.equal(value)
            expect(await hookToken.balanceOf(runner)).to.equal(tip)
        })
    })
})
