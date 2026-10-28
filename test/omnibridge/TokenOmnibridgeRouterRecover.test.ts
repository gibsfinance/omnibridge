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

    /** Finds a gas budget where the mediator succeeds but the router callback runs out of gas. */
    const strand = async (messageId: string, innerCall: string) => {
        for (let gas = 60_000n; gas < 700_000n; gas += 2_000n) {
            const snapshot = await takeSnapshot()
            await deliver(messageId, innerCall, gas)
            const stranded = (await token.balanceOf(router)) === value
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
})
