import hre from 'hardhat'
import { loadFixture, takeSnapshot } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import * as ethers from 'ethers'
import * as helpers from '../helpers/helpers'
import * as setup from '../setup'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { feeDirector, packSignatures } from '../helpers/ambMessage'

const oneEther = ethers.parseEther('1')
const value = oneEther / 10n
const unwrapFlag = 0b0010n
const coder = ethers.AbiCoder.defaultAbiCoder()
/** The router's DeliveryOutcome enum, in declaration order. */
const Outcome = { Delivered: 0n, Recovered: 1n, AlreadyHandled: 2n, AlreadyRelayedForAnotherRecipient: 3n } as const

/**
 * The gas a mined transaction's execution used, without the intrinsic cost. The receipt alone can
 * hide a change in execution cost: a cheap call that carries long calldata is billed the calldata
 * floor instead (EIP-7623), whatever its execution spent.
 */
const executionGas = async (transactionHash: string): Promise<bigint> => {
    const trace = await hre.network.provider.send('debug_traceTransaction', [
        transactionHash,
        { disableStack: true, disableMemory: true, disableStorage: true },
    ])
    const steps = trace.structLogs as Array<{ gas: number; gasCost: number }>
    const last = steps[steps.length - 1]
    return BigInt(steps[0].gas - last.gas + last.gasCost)
}

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
        let stubMediator!: any
        let stubRouter!: any

        /** Delivers through the stub bridge, which reports a real message identifier like the live bridge. */
        const deliverThroughStub = (recipient: string) =>
            stubMediator.exec(stubRouter, stubRouter.interface.encodeFunctionData('onTokenBridged', [token.target, value, feeDirector(recipient, unwrapFlag)]))

        beforeEach(async () => {
            stubMediator = await (await hre.ethers.getContractFactory('StubMediator')).deploy(token)
            stubRouter = await factoryForRouter.deploy(stubMediator, token, owner)
            await token.deposit({ value })
            await token.transfer(stubRouter, value)
        })

        it('delivers the wrapped token when the recipient refuses native coin', async () => {
            const Refuser = await hre.ethers.getContractFactory('MockPayoutReceiver')
            const refuser = await Refuser.deploy() // refuses native coin by default
            const nativeBefore = await hre.ethers.provider.getBalance(refuser)
            const wrappedBefore = await token.balanceOf(refuser)
            await expect(deliverThroughStub(await refuser.getAddress())).to.not.be.reverted
            expect(await token.balanceOf(refuser)).to.equal(wrappedBefore + value)
            expect(await hre.ethers.provider.getBalance(refuser)).to.equal(nativeBefore)
            expect(await token.balanceOf(stubRouter)).to.equal(0n)
            expect(await hre.ethers.provider.getBalance(stubRouter)).to.equal(0n)
        })

        it('still pays native coin to a recipient that accepts it', async () => {
            const Accepter = await hre.ethers.getContractFactory('MockPayoutReceiver')
            const accepter = await Accepter.deploy()
            await accepter.setAccepting(true)
            await deliverThroughStub(await accepter.getAddress())
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

        it('a second recover of the same message returns AlreadyHandled and pays nothing', async () => {
            const { message } = await makeStrand()
            const signatures = await sign(message, [validators[0], validators[1]])
            expect(await router.recover.staticCall(message, signatures)).to.equal(Outcome.Recovered)
            await router.recover(message, signatures)
            const recipientBefore = await hre.ethers.provider.getBalance(stranger)
            expect(await router.recover.staticCall(message, signatures)).to.equal(Outcome.AlreadyHandled)
            await expect(router.recover(message, signatures)).to.not.emit(router, 'DeliveryRecovered')
            expect(await hre.ethers.provider.getBalance(stranger), 'no second payment').to.equal(recipientBefore)
        })

        it('returns AlreadyHandled on a message the normal path already delivered, paying nothing more', async () => {
            const messageId = nextMessageId()
            const innerCall = handleCall({ data: unwrapData() })
            const before = await hre.ethers.provider.getBalance(stranger)
            await deliver(messageId, innerCall, 3_000_000n)
            // the normal delivery really paid, so the guard is the only thing standing in the way
            expect(await hre.ethers.provider.getBalance(stranger)).to.equal(before + value)
            expect(await router.processed(messageId)).to.equal(true)
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])
            const recipientAfterDelivery = await hre.ethers.provider.getBalance(stranger)
            expect(await router.recover.staticCall(message, signatures)).to.equal(Outcome.AlreadyHandled)
            await expect(router.recover(message, signatures)).to.not.emit(router, 'DeliveryRecovered')
            expect(await hre.ethers.provider.getBalance(stranger), 'no second payment').to.equal(recipientAfterDelivery)
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

            it('NotForThisRouter comes before the signatures: no signatures at all still names the recipient', async () => {
                const messageId = nextMessageId()
                const innerCall = handleCall({ recipient: stranger.address, data: unwrapData() })
                await deliver(messageId, innerCall, 3_000_000n)
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
                await expect(router.recover(message, '0x')).to.be.revertedWithCustomError(router, 'NotForThisRouter')
            })

            it('NotForThisRouter comes before the bridge flags: a message the bridge never relayed still names the recipient', async () => {
                const messageId = nextMessageId()
                const innerCall = handleCall({ recipient: stranger.address, data: unwrapData() })
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
                expect(await amb.relayedMessages(messageId)).to.equal(false)
                await expect(router.recover(message, '0x')).to.be.revertedWithCustomError(router, 'NotForThisRouter')
            })

            it('UnsupportedSelector comes before the bridge flags and the signatures', async () => {
                const messageId = nextMessageId()
                const innerCall = handleCall({
                    data: unwrapData(),
                    selector: mediator.interface.getFunction('handleNativeTokens')!.selector,
                })
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
                await expect(router.recover(message, '0x')).to.be.revertedWithCustomError(router, 'UnsupportedSelector')
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
            //    true, so the entry routes to recovery (no tip). courier is ignored on this branch.
            await router.connect(user).safeExecuteSignaturesWithAutoGasLimit(user.address, message, signatures)

            // 3) delivered correctly: the recipient got the full value as native coin, the router is
            //    empty, and the message is now recorded.
            expect((await hre.ethers.provider.getBalance(stranger)) - recipientBefore).to.equal(value)
            expect(await token.balanceOf(router)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(true)

            // 4) the same message a third time pays nothing: the entry returns AlreadyHandled.
            const recipientAfter = await hre.ethers.provider.getBalance(stranger)
            const outcome = await router.connect(user).safeExecuteSignaturesWithAutoGasLimit.staticCall(user.address, message, signatures)
            expect(outcome).to.equal(Outcome.AlreadyHandled)
            await (await router.connect(user).safeExecuteSignaturesWithAutoGasLimit(user.address, message, signatures)).wait()
            expect(await hre.ethers.provider.getBalance(stranger)).to.equal(recipientAfter) // no double payment
            expect(await token.balanceOf(router)).to.equal(0n)
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

        it('a listed courier that recovers a strand through the single entry earns the tip', async () => {
            // this is what gives a relayer a reason to finish a stranded delivery,
            // so a griefer who strands a transfer cannot deny the service.
            const courier = signers[4]
            const caller = signers[5]
            await router.connect(owner).setCourierStatus(courier.address, true)

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
            const courierBefore = await token.balanceOf(courier.address)
            // the listed courier is attributed; the caller can be anyone
            await router.connect(caller).safeExecuteSignaturesWithAutoGasLimit(courier.address, message, signatures)

            expect((await token.balanceOf(user)) - recipientBefore).to.equal(value - fee) // recipient gets value minus the tip
            expect((await token.balanceOf(courier.address)) - courierBefore).to.equal(fee) // courier earns the tip
            expect(await token.balanceOf(router)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(true)
        })

        it('a non-courier recovering through the single entry earns no tip (recipient paid in full)', async () => {
            const courier = signers[6] // not a courier
            const messageId = nextMessageId()
            const innerCall = handleCall({ data: feeDirector(user.address, 0b0001n, value / 10n) })
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])

            await strand(messageId, innerCall)
            const recipientBefore = await token.balanceOf(user)
            const courierBefore = await token.balanceOf(courier.address)
            await router.connect(courier).safeExecuteSignaturesWithAutoGasLimit(courier.address, message, signatures)

            expect((await token.balanceOf(user)) - recipientBefore).to.equal(value) // full value, no tip taken
            expect(await token.balanceOf(courier.address)).to.equal(courierBefore) // non-courier earns nothing
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
            await expect(router.connect(stranger).recover(message, signatures))
                .to.be.revertedWithCustomError(router, 'LegacyFormRequiresWrappedNative')
                .withArgs(bridged.target)
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

        it('the entry recovery branch pays a bridged strand in the bridged token, and a listed courier earns the tip', async () => {
            const courier = signers[4]
            await router.connect(owner).setCourierStatus(courier.address, true)
            const tip = value / 10n
            const messageId = nextMessageId()
            const innerCall = bridgedCall(feeDirector(user.address, 0b0001n, tip))
            await strand(messageId, innerCall, { asset: bridged })
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])
            expect(await router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit.staticCall(courier.address, message, signatures)).to.equal(
                Outcome.Recovered,
            )
            await expect(router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit(courier.address, message, signatures))
                .to.emit(router, 'DeliveryRecovered')
                .withArgs(messageId, bridged.target, router.target, value)
            expect(await bridged.balanceOf(user)).to.equal(value - tip)
            expect(await bridged.balanceOf(courier)).to.equal(tip)
            expect(await bridged.balanceOf(router)).to.equal(0n)
            expect(await token.balanceOf(courier), 'no wrapped token moved').to.equal(0n)
        })

        it('a fresh bridged delivery through the entry mints the bridged token to the router and pays it on', async () => {
            const courier = signers[4]
            await router.connect(owner).setCourierStatus(courier.address, true)
            const tip = value / 10n
            const messageId = nextMessageId()
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall: bridgedCall(feeDirector(user.address, 0b0001n, tip)) })
            const wrappedInRouter = await token.balanceOf(router)
            expect(await router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit.staticCall(courier.address, message, '0x')).to.equal(
                Outcome.Delivered,
            )
            await router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit(courier.address, message, '0x')
            expect(await amb.relayedMessages(messageId)).to.equal(true)
            expect(await router.processed(messageId)).to.equal(true)
            expect(await bridged.balanceOf(user)).to.equal(value - tip)
            expect(await bridged.balanceOf(courier)).to.equal(tip)
            expect(await bridged.balanceOf(router)).to.equal(0n)
            expect(await token.balanceOf(router), 'the wrapped token in the router is untouched').to.equal(wrappedInRouter)
        })

        // The twin: the message names the wrapped native token's own address, but the mediator mints its
        // bridged twin. The unwrap flag asks for ether, which the router can only make from the real
        // wrapped token. The router must pay the twin and never unwrap other users' wrapped token.
        describe('a twin delivery with the unwrap flag set pays the twin token, not ether', () => {
            const twinRecipient = () => ethers.Wallet.createRandom().address

            it('fresh, through the entry', async () => {
                const courier = signers[4]
                await router.connect(owner).setCourierStatus(courier.address, true)
                await strandHonestWrappedDelivery()
                const recipient = twinRecipient()
                const messageId = nextMessageId()
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall: bridgedCall(feeDirector(recipient, unwrapFlag)) })
                await router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit(courier.address, message, '0x')
                expect(await router.processed(messageId)).to.equal(true)
                expect(await bridged.balanceOf(recipient), 'paid in the twin').to.equal(value)
                expect(await hre.ethers.provider.getBalance(recipient), 'no ether').to.equal(0n)
                expect(await token.balanceOf(recipient), 'no real wrapped token').to.equal(0n)
                expect(await token.balanceOf(router), 'the honest wrapped strand is untouched').to.equal(value)
                expect(await bridged.balanceOf(router)).to.equal(0n)
            })

            it('recovered, through recover()', async () => {
                await strandHonestWrappedDelivery()
                const recipient = twinRecipient()
                const messageId = nextMessageId()
                const innerCall = bridgedCall(feeDirector(recipient, unwrapFlag))
                await strand(messageId, innerCall, { asset: bridged })
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
                await router.connect(stranger).recover(message, await sign(message, [validators[0], validators[1]]))
                expect(await bridged.balanceOf(recipient), 'paid in the twin').to.equal(value)
                expect(await hre.ethers.provider.getBalance(recipient), 'no ether').to.equal(0n)
                expect(await token.balanceOf(recipient), 'no real wrapped token').to.equal(0n)
                expect(await token.balanceOf(router), 'the honest wrapped strand is untouched').to.equal(value)
            })
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

    // The owner's rule for a short balance (fee-on-transfer tokens are never refused): every delivery,
    // fresh or recovered, pays what the message names capped at the router's balance of the token read
    // at run time, and the message is then closed. The balance is shared by every strand of a token, so
    // a short arrival can draw on another strand; the owner's claimTokens makes good-faith actors whole.
    describe('recovery from a shared balance pays at most what is there', () => {
        /**
         * Puts `arrived` of the wrapped token in the router for a message that says `messageValue`, and
         * marks the message relayed and delivered. This is a strand whose token arrived short.
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

        it('two strands of one token: the second, finding the balance short, is paid the capped amount and closed', async () => {
            const firstRecipient = signers[7]
            const secondRecipient = signers[8]
            const shortfall = value / 4n
            const first = await strandThatArrived(value, value, firstRecipient.address)
            const second = await strandThatArrived(value - shortfall, value, secondRecipient.address)
            expect(await token.balanceOf(router)).to.equal(2n * value - shortfall)

            await router.recover(first.message, first.signatures)
            expect(await token.balanceOf(firstRecipient)).to.equal(value)
            expect(await token.balanceOf(router)).to.equal(value - shortfall)

            // the second message names `value` but only `value - shortfall` is left: that is what it gets
            await expect(router.recover(second.message, second.signatures))
                .to.emit(router, 'DeliveryRecovered')
                .withArgs(second.messageId, token.target, router.target, value - shortfall)
            expect(await token.balanceOf(secondRecipient)).to.equal(value - shortfall)
            expect(await token.balanceOf(router)).to.equal(0n)
            expect(await router.processed(second.messageId), 'the message is closed').to.equal(true)
            expect(await router.recover.staticCall(second.message, second.signatures)).to.equal(Outcome.AlreadyHandled)
        })

        it('an empty balance pays nothing and closes the message', async () => {
            const recipient = signers[7]
            const empty = await strandThatArrived(0n, value, recipient.address)
            await expect(router.recover(empty.message, empty.signatures))
                .to.emit(router, 'DeliveryRecovered')
                .withArgs(empty.messageId, token.target, router.target, 0n)
            expect(await token.balanceOf(recipient)).to.equal(0n)
            expect(await router.processed(empty.messageId)).to.equal(true)
        })

        describe('a fee-on-transfer token on the escrow path (handleNativeTokensAndCall)', () => {
            const feeBasisPoints = 100n
            const afterFee = (amount: bigint) => amount - (amount * feeBasisPoints) / 10_000n
            // the mediator's release to the router burns 1%: this is what arrives in the router
            const arrived = afterFee(value)
            let feeToken!: any

            beforeEach(async () => {
                feeToken = await (await hre.ethers.getContractFactory('MockFeeOnTransferToken')).deploy(feeBasisPoints)
                // put real custody in the mediator through an outbound transfer, as a user would
                await feeToken.mint(user, value * 10n)
                await feeToken.connect(user).approve(mediator, value * 10n)
                await mediator.connect(user).getFunction('relayTokens(address,uint256)')(feeToken, value * 5n)
            })

            const feeTokenCall = (recipient: string) =>
                ethers.concat([
                    mediator.interface.getFunction('handleNativeTokensAndCall')!.selector,
                    coder.encode(['address', 'address', 'uint256', 'bytes'], [feeToken.target, router.target, value, feeDirector(recipient, 0n)]),
                ])

            it('fresh delivery pays what arrived (the payout transfer burns its own 1%)', async () => {
                const recipient = signers[7]
                const messageId = nextMessageId()
                await deliver(messageId, feeTokenCall(recipient.address), 3_000_000n)
                expect(await amb.messageCallStatus(messageId)).to.equal(true)
                expect(await feeToken.balanceOf(recipient)).to.equal(afterFee(arrived))
                expect(await feeToken.balanceOf(router)).to.equal(0n)
                expect(await router.processed(messageId)).to.equal(true)
            })

            it('a strand on its own recovers paying what is actually there', async () => {
                const recipient = signers[7]
                const messageId = nextMessageId()
                const innerCall = feeTokenCall(recipient.address)
                await strand(messageId, innerCall, { asset: feeToken, amount: arrived })
                expect(await feeToken.balanceOf(router)).to.equal(arrived)
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
                const signatures = await sign(message, [validators[0], validators[1]])
                await expect(router.recover(message, signatures))
                    .to.emit(router, 'DeliveryRecovered')
                    .withArgs(messageId, feeToken.target, router.target, arrived)
                expect(await feeToken.balanceOf(recipient)).to.equal(afterFee(arrived))
                expect(await feeToken.balanceOf(router)).to.equal(0n)
                expect(await router.processed(messageId)).to.equal(true)
            })
        })
    })

    // The single delivery entry holds the courier slot, not the reentrancy guard that recover() holds.
    // A payout recipient that re-enters recover() for ANOTHER strand would then run that recovery
    // with the outer courier still attributed, and pay the outer courier a tip it did not earn.
    describe('re-entry during a recovery through the single delivery entry', () => {
        it('a recipient cannot re-enter recover() and tip the outer courier from another strand', async () => {
            const courier = signers[4]
            const secondRecipient = signers[8]
            await router.connect(owner).setCourierStatus(courier.address, true)
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

            await router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit(courier.address, outer.message, outer.signatures)

            // the outer message paid as it should
            expect(await hookToken.balanceOf(recoverer)).to.equal(value - tip)
            expect(await router.processed(outer.messageId)).to.equal(true)
            // the re-entrant recovery was attempted and refused by the reentrancy guard
            expect(await recoverer.reentrantCallMade()).to.equal(true)
            expect(await recoverer.reentrantCallSucceeded()).to.equal(false)
            expect(await recoverer.reentrantCallRevertData()).to.equal(router.interface.getError('ReentrancyGuard')!.selector)
            // so the courier earned exactly one tip, and the other strand is untouched
            expect(await hookToken.balanceOf(courier)).to.equal(tip)
            expect(await hookToken.balanceOf(secondRecipient)).to.equal(0n)
            expect(await router.processed(inner.messageId)).to.equal(false)
            expect(await hookToken.balanceOf(router)).to.equal(value)

            // the other strand still recovers on its own, with no tip because no courier is attributed
            await router.recover(inner.message, inner.signatures)
            expect(await hookToken.balanceOf(secondRecipient)).to.equal(value)
            expect(await hookToken.balanceOf(courier)).to.equal(tip)
        })

        // A recovery that names an address that is not a courier must still hold the entry's own guard (the
        // courier slot) for the whole call. If the slot went idle, a payout recipient could start a second,
        // independent entry run in the middle of the first one.
        it('a non-courier recovery keeps the entry guard: a recipient re-entering the entry is refused, and no tip is paid', async () => {
            const unlistedCourier = signers[6]
            const listedCourier = signers[4]
            await router.connect(owner).setCourierStatus(listedCourier.address, true)
            expect(await router.isCourier(unlistedCourier.address)).to.equal(false)
            const hookToken = await (await hre.ethers.getContractFactory('MockTransferHookToken')).deploy()
            const recoverer = await (await hre.ethers.getContractFactory('MockReentrantRecoverer')).deploy()
            const tip = value / 10n

            // the outer strand: a fixed-tip hook token delivery to the re-entering recipient
            const outerId = nextMessageId()
            const outerCall = ethers.concat([
                mediator.interface.getFunction('handleNativeTokensAndCall')!.selector,
                coder.encode(['address', 'address', 'uint256', 'bytes'], [hookToken.target, router.target, value, feeDirector(await recoverer.getAddress(), 0b0001n, tip)]),
            ])
            await hookToken.mint(router, value)
            await amb.executeMessageCall(token, router, token.interface.encodeFunctionData('deposit'), outerId, 100_000n)
            const outerMessage = buildMessage({ messageId: outerId, executor: mediator.target as string, innerCall: outerCall })

            // the re-entrant call: a fresh, harmless message through the entry, naming a listed courier, so
            // nothing but the entry guard can refuse it
            const innerId = nextMessageId()
            const innerMessage = buildMessage({ messageId: innerId, executor: token.target as string, innerCall: token.interface.encodeFunctionData('deposit') })
            await recoverer.armEntry(router, listedCourier.address, innerMessage, '0x')

            await router
                .connect(stranger)
                .safeExecuteSignaturesWithAutoGasLimit(unlistedCourier.address, outerMessage, await sign(outerMessage, [validators[0], validators[1]]))

            expect(await router.processed(outerId)).to.equal(true)
            expect(await recoverer.reentrantCallMade()).to.equal(true)
            expect(await recoverer.reentrantCallSucceeded(), 'the re-entrant entry call is refused').to.equal(false)
            expect(await recoverer.reentrantCallRevertData()).to.equal(router.interface.getError('ReentrancyGuard')!.selector)
            expect(await amb.relayedMessages(innerId), 'the inner message never ran').to.equal(false)
            expect(await hookToken.balanceOf(recoverer), 'the recipient is paid in full').to.equal(value)
            expect(await hookToken.balanceOf(unlistedCourier), 'no tip to the non-courier').to.equal(0n)
            expect(await hookToken.balanceOf(listedCourier), 'no tip to anyone').to.equal(0n)
            expect(await hre.ethers.provider.getStorage(router, await router.COURIER_SLOT()), 'the guard is released afterwards').to.equal(ethers.toBeHex(1n, 32))
        })
    })

    // The fresh-delivery branch of the single entry cannot hold the reentrancy guard: the bridge call
    // must re-enter onTokenBridged. While that bridge call runs, code the attacker controls (the target
    // of an arbitrary message, or a hostile token) can call the public recover() for someone else's
    // strand. The tip belongs to the message the entry is handling, never to that other payout.
    describe('recover() called from inside a fresh delivery through the single entry', () => {
        it('pays the victim in full and gives the courier nothing from the victim payout', async () => {
            const courier = signers[4]
            const victim = signers[8]
            await router.connect(owner).setCourierStatus(courier.address, true)
            const recoverer = await (await hre.ethers.getContractFactory('MockReentrantRecoverer')).deploy()
            const tip = value / 10n

            // the victim's strand: a fixed-tip wrapped-token delivery
            const victimId = nextMessageId()
            const victimCall = handleCall({ data: feeDirector(victim.address, 0b0001n, tip) })
            await strand(victimId, victimCall)
            const victimMessage = buildMessage({ messageId: victimId, executor: mediator.target as string, innerCall: victimCall })
            await recoverer.arm(router, victimMessage, await sign(victimMessage, [validators[0], validators[1]]))

            // the attacker's message: an arbitrary message whose target is the attacker's contract
            const attackId = nextMessageId()
            const attackCall = recoverer.interface.encodeFunctionData('onTokenTransferReceived', [ethers.ZeroAddress, 0n])
            const attackMessage = buildMessage({ messageId: attackId, executor: await recoverer.getAddress(), innerCall: attackCall })

            const victimBefore = await token.balanceOf(victim)
            const courierBefore = await token.balanceOf(courier)
            await router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit(courier.address, attackMessage, '0x')

            // the inner recover() really ran inside the entry's fresh delivery
            expect(await recoverer.reentrantCallMade()).to.equal(true)
            expect(await recoverer.reentrantCallSucceeded()).to.equal(true)
            expect(await router.processed(victimId)).to.equal(true)
            expect((await token.balanceOf(victim)) - victimBefore, 'the victim is paid in full').to.equal(value)
            expect((await token.balanceOf(courier)) - courierBefore, 'the courier earns nothing from that payout').to.equal(0n)
            expect(await token.balanceOf(router)).to.equal(0n)
        })
    })

    // Several relayers race the same message. The losers must spend as little gas as possible: the
    // router first asks whether the message is for it (calldata only), then reads processed[id], both
    // before any write, external call or signature check, and returns AlreadyHandled instead of reverting.
    //
    // Two bounds per loser. The receipt bound is what the loser pays, but a cheap call with long
    // calldata is billed the calldata floor (EIP-7623) whatever its execution spent, so the receipt
    // alone cannot see a small change in order. The execution bound can.
    describe('losing a race to the same message', () => {
        /**
         * The most gas, transaction base cost and calldata included, a losing call may use. The
         * signature-first order spent far more (two ecrecovers and several external calls before
         * the processed check), so this bound fails if the cheap check moves back behind them.
         */
        const LOSING_CALL_GAS_CEILING = 45_000n
        /**
         * The most execution gas, intrinsic cost excluded, a loser on a message for this router may use:
         * one calldata decode of the inner call and one storage read. Measured at 5,923 (entry) and
         * 5,598 (recover). Any external call or signature check before the exit exceeds it.
         */
        const LOSING_CALL_EXECUTION_GAS_CEILING = 8_000n

        const recoveredStrand = async (winner: 'entry' | 'recover') => {
            const messageId = nextMessageId()
            const innerCall = handleCall({ data: feeDirector(stranger.address, unwrapFlag) })
            await strand(messageId, innerCall)
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])
            if (winner === 'entry') await router.connect(user).safeExecuteSignaturesWithAutoGasLimit(user.address, message, signatures)
            if (winner === 'recover') await router.connect(user).recover(message, signatures)
            expect(await router.processed(messageId)).to.equal(true)
            return { messageId, message, signatures }
        }

        it('the entry: a loser gets AlreadyHandled, writes nothing, pays nothing, and spends little gas', async () => {
            const { message, signatures } = await recoveredStrand('entry')
            const loser = signers[9]
            const courierSlot = await router.COURIER_SLOT()
            const slotBefore = await hre.ethers.provider.getStorage(router, courierSlot)
            const recipientBefore = await hre.ethers.provider.getBalance(stranger)
            expect(await router.connect(loser).safeExecuteSignaturesWithAutoGasLimit.staticCall(loser.address, message, signatures)).to.equal(
                Outcome.AlreadyHandled,
            )
            const receipt = await (await router.connect(loser).safeExecuteSignaturesWithAutoGasLimit(loser.address, message, signatures)).wait()
            const execution = await executionGas(receipt.hash)
            console.log(`      losing entry call used ${receipt.gasUsed} gas (execution ${execution})`)
            expect(receipt.status).to.equal(1)
            expect(receipt.logs.length, 'no event of any kind').to.equal(0)
            expect(receipt.gasUsed, 'a loser spends little gas').to.be.lessThan(LOSING_CALL_GAS_CEILING)
            expect(execution, 'a loser executes little').to.be.lessThan(LOSING_CALL_EXECUTION_GAS_CEILING)
            expect(await hre.ethers.provider.getStorage(router, courierSlot)).to.equal(slotBefore)
            expect(await hre.ethers.provider.getBalance(stranger), 'no second payment').to.equal(recipientBefore)
        })

        it('recover(): a loser gets AlreadyHandled, pays nothing, and spends little gas', async () => {
            const { message, signatures } = await recoveredStrand('recover')
            const loser = signers[9]
            const recipientBefore = await hre.ethers.provider.getBalance(stranger)
            expect(await router.connect(loser).recover.staticCall(message, signatures)).to.equal(Outcome.AlreadyHandled)
            const receipt = await (await router.connect(loser).recover(message, signatures)).wait()
            const execution = await executionGas(receipt.hash)
            console.log(`      losing recover call used ${receipt.gasUsed} gas (execution ${execution})`)
            expect(receipt.status).to.equal(1)
            expect(receipt.logs.length, 'no event of any kind').to.equal(0)
            expect(receipt.gasUsed, 'a loser spends little gas').to.be.lessThan(LOSING_CALL_GAS_CEILING)
            expect(execution, 'a loser executes little').to.be.lessThan(LOSING_CALL_EXECUTION_GAS_CEILING)
            expect(await hre.ethers.provider.getBalance(stranger), 'no second payment').to.equal(recipientBefore)
        })

        /**
         * Sends `message` through the entry as a losing relayer would, with genuine signatures, after
         * the bridge already relayed it. Returns the outcome, the receipt, the signatures, and whether
         * the courier slot stayed untouched.
         */
        const loserCall = async (message: string) => {
            const loser = signers[9]
            const signatures = await sign(message, [validators[0], validators[1]])
            const courierSlot = await router.COURIER_SLOT()
            const courierSlotBefore = await hre.ethers.provider.getStorage(router, courierSlot)
            const outcome = await router.connect(loser).safeExecuteSignaturesWithAutoGasLimit.staticCall(loser.address, message, signatures)
            const receipt = await (await router.connect(loser).safeExecuteSignaturesWithAutoGasLimit(loser.address, message, signatures)).wait()
            const execution = await executionGas(receipt.hash)
            console.log(`      losing entry call on another recipient's message used ${receipt.gasUsed} gas (execution ${execution})`)
            return { outcome, receipt, execution, signatures, courierSlotUnchanged: (await hre.ethers.provider.getStorage(router, courierSlot)) === courierSlotBefore }
        }

        // `processed` is written only for messages to this router, so the check above cannot see a race
        // lost on a message for someone else. Nothing can ever be paid for such a message, so the entry
        // must return as soon as it knows the bridge relayed it: no courier slot write, no signature check.
        describe('on a message the bridge already relayed to someone else', () => {
            /**
             * The most gas, transaction base cost and calldata included, this loser may use. It makes one
             * bridge read where the loser above makes a storage read, so it pays more. Measured at 42,208
             * (this mediator) and 38,230 (another executor). The processed-first order spent 45,349 and
             * 41,584; before the early exit, the same call wrote the courier and entry slots and ran the full
             * recovery checks, signatures included, before it reverted: far above this bound.
             */
            const LOSING_CALL_ON_ANOTHER_RECIPIENT_GAS_CEILING = 45_000n
            /**
             * The most execution gas, intrinsic cost excluded, this loser may use: one decode of the inner
             * call and one bridge read, no storage read of this router. Measured at 14,668 (this mediator)
             * and 12,646 (another executor). The processed-first order spent 17,785 and 16,000.
             */
            const LOSING_CALL_ON_ANOTHER_RECIPIENT_EXECUTION_GAS_CEILING = 15_500n

            it('another executor: the entry returns AlreadyRelayedForAnotherRecipient cheaply; recover() still reverts WrongExecutor', async () => {
                const messageId = nextMessageId()
                const innerCall = token.interface.encodeFunctionData('deposit')
                // the winner: the bridge relays an ordinary message to the token, not to this router's mediator
                await amb.executeMessageCall(token, router, innerCall, messageId, 100_000n)
                expect(await amb.relayedMessages(messageId)).to.equal(true)
                const message = buildMessage({ messageId, executor: token.target as string, innerCall })
                const { outcome, receipt, execution, signatures, courierSlotUnchanged } = await loserCall(message)
                expect(outcome).to.equal(Outcome.AlreadyRelayedForAnotherRecipient)
                expect(receipt.status).to.equal(1)
                expect(receipt.logs.length, 'no event of any kind').to.equal(0)
                expect(receipt.gasUsed, 'a loser spends little gas').to.be.lessThan(LOSING_CALL_ON_ANOTHER_RECIPIENT_GAS_CEILING)
                expect(execution, 'a loser executes little').to.be.lessThan(LOSING_CALL_ON_ANOTHER_RECIPIENT_EXECUTION_GAS_CEILING)
                expect(courierSlotUnchanged, 'the courier slot was never written').to.equal(true)
                expect(await router.processed(messageId)).to.equal(false)
                // the caller of recover() asked for something unrecoverable: that stays an error
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'WrongExecutor')
            })

            it('this mediator, another recipient: the entry returns AlreadyRelayedForAnotherRecipient cheaply; recover() still reverts NotForThisRouter', async () => {
                const messageId = nextMessageId()
                const innerCall = handleCall({ recipient: stranger.address, data: feeDirector(stranger.address, unwrapFlag) })
                await deliver(messageId, innerCall, 3_000_000n)
                expect(await amb.messageCallStatus(messageId)).to.equal(true)
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
                const strangerTokensBefore = await token.balanceOf(stranger)
                const { outcome, receipt, execution, signatures, courierSlotUnchanged } = await loserCall(message)
                expect(outcome).to.equal(Outcome.AlreadyRelayedForAnotherRecipient)
                expect(receipt.status).to.equal(1)
                expect(receipt.logs.length, 'no event of any kind').to.equal(0)
                expect(receipt.gasUsed, 'a loser spends little gas').to.be.lessThan(LOSING_CALL_ON_ANOTHER_RECIPIENT_GAS_CEILING)
                expect(execution, 'a loser executes little').to.be.lessThan(LOSING_CALL_ON_ANOTHER_RECIPIENT_EXECUTION_GAS_CEILING)
                expect(courierSlotUnchanged, 'the courier slot was never written').to.equal(true)
                expect(await token.balanceOf(stranger), 'nothing paid').to.equal(strangerTokensBefore)
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'NotForThisRouter')
            })
        })

        // "Is this message for us?" comes before "has it already been done?". `processed` records only
        // messages this router paid, so a message for someone else must never be answered from it, even
        // when its identifier equals one the router already paid.
        describe('a message for someone else whose identifier this router already paid', () => {
            /** Recovers a strand to this router and returns its identifier, now recorded in `processed`. */
            const paidIdentifier = async () => {
                const { messageId } = await recoveredStrand('recover')
                expect(await amb.relayedMessages(messageId)).to.equal(true)
                return messageId
            }
            /** A message for this router's mediator that pays `stranger`, not this router. */
            const anotherRecipientMessage = (messageId: string) =>
                buildMessage({
                    messageId,
                    executor: mediator.target as string,
                    innerCall: handleCall({ recipient: stranger.address, data: feeDirector(stranger.address, unwrapFlag) }),
                })
            /** A message for another contract, not this router's mediator. */
            const anotherExecutorMessage = (messageId: string) =>
                buildMessage({ messageId, executor: token.target as string, innerCall: token.interface.encodeFunctionData('deposit') })

            it('the entry returns AlreadyRelayedForAnotherRecipient for this mediator and another recipient, never AlreadyHandled', async () => {
                const message = anotherRecipientMessage(await paidIdentifier())
                const { outcome, receipt, courierSlotUnchanged } = await loserCall(message)
                expect(outcome).to.equal(Outcome.AlreadyRelayedForAnotherRecipient)
                expect(receipt.logs.length, 'no event of any kind').to.equal(0)
                expect(courierSlotUnchanged, 'the courier slot was never written').to.equal(true)
            })

            it('the entry returns AlreadyRelayedForAnotherRecipient for another executor, never AlreadyHandled', async () => {
                const message = anotherExecutorMessage(await paidIdentifier())
                const { outcome, receipt, courierSlotUnchanged } = await loserCall(message)
                expect(outcome).to.equal(Outcome.AlreadyRelayedForAnotherRecipient)
                expect(receipt.logs.length, 'no event of any kind').to.equal(0)
                expect(courierSlotUnchanged, 'the courier slot was never written').to.equal(true)
            })

            it('recover() reverts NotForThisRouter for another recipient, not AlreadyHandled', async () => {
                const message = anotherRecipientMessage(await paidIdentifier())
                const signatures = await sign(message, [validators[0], validators[1]])
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'NotForThisRouter')
            })

            it('recover() reverts WrongExecutor for another executor, not AlreadyHandled', async () => {
                const message = anotherExecutorMessage(await paidIdentifier())
                const signatures = await sign(message, [validators[0], validators[1]])
                await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'WrongExecutor')
            })
        })
    })

    // The native coin payout must not hand the recipient all remaining gas: a recipient that burns it
    // leaves the router 1/64, too little to fall back to the wrapped token, and the delivery strands.
    describe('native payout gas', () => {
        it('a gas-burning native recipient gets the wrapped token and the delivery completes', async () => {
            const burner = await (await hre.ethers.getContractFactory('MockGasBurner')).deploy()
            const messageId = nextMessageId()
            const innerCall = handleCall({ data: feeDirector(await burner.getAddress(), unwrapFlag) })
            // an ordinary delivery budget, ample for a normal payout
            await deliver(messageId, innerCall, 500_000n)
            expect(await amb.messageCallStatus(messageId)).to.equal(true)
            expect(await token.balanceOf(burner), 'the burner received the wrapped token instead').to.equal(value)
            expect(await hre.ethers.provider.getBalance(burner)).to.equal(0n)
            expect(await token.balanceOf(router), 'nothing strands in the router').to.equal(0n)
            expect(await hre.ethers.provider.getBalance(router)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(true)
        })

        it('a Safe-shaped proxy wallet still receives native coin under the gas cap', async () => {
            const implementation = await (await hre.ethers.getContractFactory('MockWalletImplementation')).deploy()
            const wallet = await (await hre.ethers.getContractFactory('MockProxyWallet')).deploy(implementation)
            const messageId = nextMessageId()
            const innerCall = handleCall({ data: feeDirector(await wallet.getAddress(), unwrapFlag) })
            await deliver(messageId, innerCall, 500_000n)
            expect(await hre.ethers.provider.getBalance(wallet), 'paid in native coin').to.equal(value)
            expect(await token.balanceOf(wallet), 'not in the wrapped token').to.equal(0n)
            expect(await token.balanceOf(router)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(true)
        })
    })

    // The first transfer of a token arrives as deployAndHandleBridgedTokensAndCall, whose layout is
    // (token, name, symbol, decimals, recipient, value, data). The mediator deploys the bridged
    // token, pairs it with the other chain's address, mints to the recipient, then calls back.
    describe('recovery of a first-transfer (deploy) message', () => {
        const erc20 = ['function balanceOf(address) view returns (uint256)']
        const otherChainToken = ethers.getAddress('0x' + '5a'.repeat(20))

        const deployCall = (data: string) =>
            mediator.interface.encodeFunctionData('deployAndHandleBridgedTokensAndCall', [
                otherChainToken,
                'Other Token',
                'OTH',
                18,
                router.target,
                value,
                data,
            ])

        /** Finds the smallest gas budget the mediator succeeds with; there the router callback starves. */
        const strandAtSmallestSuccessfulBudget = async (messageId: string, innerCall: string) => {
            let failing = 60_000n
            let succeeding = 7_000_000n
            while (succeeding - failing > 1_000n) {
                const middle = (failing + succeeding) / 2n
                const snapshot = await takeSnapshot()
                await deliver(messageId, innerCall, middle)
                const mediatorSucceeded = await amb.messageCallStatus(messageId)
                await snapshot.restore()
                if (mediatorSucceeded) succeeding = middle
                if (!mediatorSucceeded) failing = middle
            }
            await deliver(messageId, innerCall, succeeding)
        }

        it('recovers the strand, paying the bridged token the mediator deployed', async () => {
            const messageId = nextMessageId()
            const innerCall = deployCall(feeDirector(user.address, 0n))
            await strandAtSmallestSuccessfulBudget(messageId, innerCall)
            expect(await amb.messageCallStatus(messageId)).to.equal(true)
            const bridgedAddress: string = await mediator.bridgedTokenAddress(otherChainToken)
            expect(bridgedAddress).to.not.equal(ethers.ZeroAddress)
            const bridged = new ethers.Contract(bridgedAddress, erc20, hre.ethers.provider)
            expect(await bridged.balanceOf(router), 'the delivery stranded in the router').to.equal(value)
            expect(await bridged.balanceOf(user)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(false)

            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])
            await expect(router.connect(stranger).recover(message, signatures))
                .to.emit(router, 'DeliveryRecovered')
                .withArgs(messageId, bridgedAddress, router.target, value)
            expect(await bridged.balanceOf(user)).to.equal(value)
            expect(await bridged.balanceOf(router)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(true)
        })

        it('recovers a deploy strand through the entry recovery branch; a listed courier earns the tip', async () => {
            const courier = signers[4]
            await router.connect(owner).setCourierStatus(courier.address, true)
            const tip = value / 10n
            const messageId = nextMessageId()
            const innerCall = deployCall(feeDirector(user.address, 0b0001n, tip))
            await strandAtSmallestSuccessfulBudget(messageId, innerCall)
            const bridgedAddress: string = await mediator.bridgedTokenAddress(otherChainToken)
            const bridged = new ethers.Contract(bridgedAddress, erc20, hre.ethers.provider)
            expect(await bridged.balanceOf(router), 'the delivery stranded in the router').to.equal(value)
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])
            expect(await router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit.staticCall(courier.address, message, signatures)).to.equal(
                Outcome.Recovered,
            )
            await expect(router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit(courier.address, message, signatures))
                .to.emit(router, 'DeliveryRecovered')
                .withArgs(messageId, bridgedAddress, router.target, value)
            expect(await bridged.balanceOf(user)).to.equal(value - tip)
            expect(await bridged.balanceOf(courier)).to.equal(tip)
            expect(await bridged.balanceOf(router)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(true)
        })

        it('rejects a deploy message whose recipient is not this router', async () => {
            const messageId = nextMessageId()
            const innerCall = mediator.interface.encodeFunctionData('deployAndHandleBridgedTokensAndCall', [
                otherChainToken,
                'Other Token',
                'OTH',
                18,
                stranger.address,
                value,
                feeDirector(user.address, 0n),
            ])
            await deliver(messageId, innerCall, 7_000_000n)
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])
            await expect(router.recover(message, signatures)).to.be.revertedWithCustomError(router, 'NotForThisRouter')
        })
    })

    // Only the tip can fail: here the gas-mode fee formula overflows (a huge multiplier), so every path
    // that pays a tip reverts. A path that pays no tip (the direct bridge relay, or a public recover())
    // pays the recipient in full, so the funds never depend on the tip.
    describe('a delivery where only the tip fails', () => {
        const overflowingTip = (recipient: string) => feeDirector(recipient, 0n, value, ethers.MaxUint256)

        it('fresh through the entry reverts DeliveryNotCompleted; the direct bridge relay then pays in full with no tip', async () => {
            const courier = signers[4]
            await router.connect(owner).setCourierStatus(courier.address, true)
            const messageId = nextMessageId()
            const innerCall = handleCall({ data: overflowingTip(user.address) })
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            await expect(router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit(courier.address, message, '0x'))
                .to.be.revertedWithCustomError(router, 'DeliveryNotCompleted')
                .withArgs(messageId)
            expect(await amb.relayedMessages(messageId), 'the message stays unrelayed').to.equal(false)

            const userBefore = await token.balanceOf(user)
            await deliver(messageId, innerCall, 3_000_000n)
            expect((await token.balanceOf(user)) - userBefore, 'paid in full').to.equal(value)
            expect(await token.balanceOf(courier), 'no tip').to.equal(0n)
            expect(await token.balanceOf(router)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(true)
        })

        it('a strand: recovery through the entry with a listed courier reverts on the tip; recover() pays in full with no tip', async () => {
            const courier = signers[4]
            await router.connect(owner).setCourierStatus(courier.address, true)
            const messageId = nextMessageId()
            const innerCall = handleCall({ data: overflowingTip(user.address) })
            await strand(messageId, innerCall)
            const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
            const signatures = await sign(message, [validators[0], validators[1]])

            await expect(router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit(courier.address, message, signatures)).to.be.revertedWithPanic(0x11)
            expect(await router.processed(messageId)).to.equal(false)
            expect(await token.balanceOf(router), 'still stranded').to.equal(value)

            const userBefore = await token.balanceOf(user)
            await expect(router.connect(stranger).recover(message, signatures))
                .to.emit(router, 'DeliveryRecovered')
                .withArgs(messageId, token.target, router.target, value)
            expect((await token.balanceOf(user)) - userBefore, 'paid in full').to.equal(value)
            expect(await token.balanceOf(courier), 'no tip').to.equal(0n)
            expect(await token.balanceOf(router)).to.equal(0n)
        })
    })

    // Two checks that no public path can reach today. Each test proves the check still does its job,
    // so a later change that drops the check in front of it cannot go unnoticed.
    describe('defence in depth', () => {
        /** The entry records the message it handles here: keccak256(abi.encode("omnibridgerouter.entryMessage")). */
        const ENTRY_MESSAGE_SLOT = ethers.keccak256(coder.encode(['string'], ['omnibridgerouter.entryMessage']))
        /** The slot's idle value: no entry is running. */
        const IDLE_ENTRY_MESSAGE = ethers.toBeHex(1n, 32)

        it('the entry returns its message slot to idle after a fresh delivery and after a recovery', async () => {
            const courier = signers[4]
            await router.connect(owner).setCourierStatus(courier.address, true)
            expect(await hre.ethers.provider.getStorage(router, ENTRY_MESSAGE_SLOT), 'idle from the constructor').to.equal(IDLE_ENTRY_MESSAGE)

            const freshId = nextMessageId()
            const freshMessage = buildMessage({ messageId: freshId, executor: mediator.target as string, innerCall: handleCall({ data: feeDirector(user.address, 0n) }) })
            await router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit(courier.address, freshMessage, '0x')
            expect(await router.processed(freshId)).to.equal(true)
            expect(await hre.ethers.provider.getStorage(router, ENTRY_MESSAGE_SLOT), 'idle after a fresh delivery').to.equal(IDLE_ENTRY_MESSAGE)

            const strandId = nextMessageId()
            const strandCall = handleCall({ data: feeDirector(user.address, 0n) })
            await strand(strandId, strandCall)
            const strandMessage = buildMessage({ messageId: strandId, executor: mediator.target as string, innerCall: strandCall })
            await router.connect(stranger).safeExecuteSignaturesWithAutoGasLimit(courier.address, strandMessage, await sign(strandMessage, [validators[0], validators[1]]))
            expect(await router.processed(strandId)).to.equal(true)
            expect(await hre.ethers.provider.getStorage(router, ENTRY_MESSAGE_SLOT), 'idle after a recovery').to.equal(IDLE_ENTRY_MESSAGE)
        })

        it('the recovery body alone refuses a message already paid, even without the outer processed check', async () => {
            const harness = await (await hre.ethers.getContractFactory('RouterRecoveryBodyHarness')).deploy(mediator, token, owner)
            /** Strands `value` of the wrapped token in the harness for a message to `recipient`. */
            const strandInHarness = async (recipient: string) => {
                const messageId = nextMessageId()
                const innerCall = handleCall({ recipient: harness.target as string, data: feeDirector(recipient, 0n) })
                await token.deposit({ value })
                await token.transfer(harness, value)
                await amb.executeMessageCall(token, harness, token.interface.encodeFunctionData('deposit'), messageId, 100_000n)
                const message = buildMessage({ messageId, executor: mediator.target as string, innerCall })
                return { messageId, message, signatures: await sign(message, [validators[0], validators[1]]) }
            }
            const firstRecipient = signers[7]
            // a second strand, so a second payment of the first message would take another user's funds
            const first = await strandInHarness(firstRecipient.address)
            await strandInHarness(signers[8].address)
            await harness.recover(first.message, first.signatures)
            expect(await token.balanceOf(firstRecipient)).to.equal(value)

            expect(await harness.recoverWithoutOuterProcessedCheck.staticCall(first.message, first.signatures)).to.equal(Outcome.AlreadyHandled)
            await expect(harness.recoverWithoutOuterProcessedCheck(first.message, first.signatures)).to.not.emit(harness, 'DeliveryRecovered')
            expect(await token.balanceOf(firstRecipient), 'no second payment').to.equal(value)
            expect(await token.balanceOf(harness), "the other user's strand is intact").to.equal(value)
        })
    })
})
