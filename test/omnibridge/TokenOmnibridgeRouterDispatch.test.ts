import hre from 'hardhat'
import { loadFixture, takeSnapshot } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import * as ethers from 'ethers'
import * as helpers from '../helpers/helpers'
import * as setup from '../setup'
import { buildMessage, handleNativeCall, packSignatures } from '../helpers/ambMessage'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'

const oneEther = ethers.parseEther('1')
const coder = ethers.AbiCoder.defaultAbiCoder()
const unwrapFlag = 0b0010n
const percentFlag = 0b1000n

const feeDirector = (recipient: string, settings: bigint, limit = 0n, multiplier = 0n) =>
    coder.encode(['address', 'uint256', 'uint256', 'uint256'], [recipient, settings, limit, multiplier])

describe('TokenOmnibridgeRouter single delivery entry', () => {
    let signers!: HardhatEthersSigner[]
    let owner!: HardhatEthersSigner

    describe('fresh message (stub bridge)', () => {
        let token!: any
        let stubMediator!: any
        let router!: any
        let user!: HardhatEthersSigner
        let runner!: HardhatEthersSigner
        let sender!: HardhatEthersSigner

        const deploy = async () => {
            signers = await hre.ethers.getSigners()
            ;[owner, user, runner, sender] = signers
            token = await (await hre.ethers.getContractFactory('WETH')).deploy()
            stubMediator = await (await hre.ethers.getContractFactory('StubMediator')).deploy(token)
            router = await (await hre.ethers.getContractFactory('TokenOmnibridgeRouter')).deploy(stubMediator, token, owner)
            await token.deposit({ value: oneEther })
            await token.transfer(router, oneEther)
        }
        beforeEach(async () => {
            await loadFixture(deploy)
        })

        const freshMessage = (data: string) =>
            buildMessage({
                messageId: ethers.keccak256(ethers.toUtf8Bytes('dispatch-fresh')),
                sender: stubMediator.target as string,
                executor: stubMediator.target as string,
                innerCall: handleNativeCall({ token: token.target as string, recipient: router.target as string, value: oneEther, data }),
            })

        it('rejects a runner that is not a validator', async () => {
            const message = freshMessage(feeDirector(user.address, percentFlag, oneEther, oneEther / 100n))
            await expect(router.connect(sender).safeExecuteSignaturesWithAutoGasLimit(runner, message, '0x')).to.be.revertedWithCustomError(
                router,
                'NotPayable',
            )
            expect(await token.balanceOf(user)).to.equal(0n)
        })

        it('delivers with a runner fee: recipient gets value minus fee, runner gets the fee', async () => {
            await router.connect(owner).setValidatorStatus(runner, true)
            const fee = oneEther / 100n
            const message = freshMessage(feeDirector(user.address, percentFlag, oneEther, fee))
            const [userBefore, runnerBefore] = [await token.balanceOf(user), await token.balanceOf(runner)]
            await router.connect(sender).safeExecuteSignaturesWithAutoGasLimit(runner, message, '0x')
            expect(await token.balanceOf(user)).to.equal(userBefore + oneEther - fee)
            expect(await token.balanceOf(runner)).to.equal(runnerBefore + fee)
            expect(await token.balanceOf(router)).to.equal(0n)
        })
    })

    describe('already relayed, stranded message (real bridge)', () => {
        const value = oneEther / 10n
        let user!: HardhatEthersSigner
        let stranger!: HardhatEthersSigner
        let validators!: ethers.HDNodeWallet[]
        let token!: any
        let mediator!: any
        let amb!: any
        let router!: any
        let counter = 0

        const deploy = async () => {
            signers = await hre.ethers.getSigners()
            ;[owner, user, , stranger] = signers
            validators = [0, 1, 2].map(() => ethers.Wallet.createRandom())
            const PermittableToken = await setup.requirePrecompiled('PermittableToken')
            const tokenImage = await PermittableToken.deploy('TEST', 'TST', 18, 1337)
            const tokenFactory = await (await hre.ethers.getContractFactory('TokenFactory')).deploy(owner, tokenImage)
            mediator = await (await hre.ethers.getContractFactory('ForeignOmnibridge')).deploy(' on Testnet')
            const bridgeValidators = await (await hre.ethers.getContractFactory('BridgeValidators')).deploy()
            await bridgeValidators.initialize(2, validators.map((wallet) => wallet.address), owner)
            amb = await (await hre.ethers.getContractFactory('AMBMock')).deploy(bridgeValidators)
            await mediator.initialize(amb, mediator, [oneEther * 100n, oneEther * 10n, 1n], [oneEther * 100n, oneEther * 10n], 1000000, owner, tokenFactory)
            token = await (await hre.ethers.getContractFactory('WETH')).deploy()
            router = await (await hre.ethers.getContractFactory('TokenOmnibridgeRouter')).deploy(mediator, token, owner)
            await router.connect(user).getFunction('wrapAndRelayTokens()')({ value: oneEther })
        }
        beforeEach(async () => {
            await loadFixture(deploy)
        })

        const sign = async (message: string, wallets: ethers.HDNodeWallet[]) => {
            const pieces = []
            for (const wallet of wallets) pieces.push(helpers.signatureToVRS(await wallet.signMessage(ethers.getBytes(message))))
            return packSignatures(pieces)
        }

        /** Finds a gas budget where the bridge reports success but the router callback ran out of gas. */
        const strand = async (messageId: string, innerCall: string) => {
            for (let gas = 60_000n; gas < 700_000n; gas += 2_000n) {
                const snapshot = await takeSnapshot()
                await amb.executeMessageCall(mediator, mediator, innerCall, messageId, gas, { gasLimit: 8_000_000n })
                if ((await token.balanceOf(router)) === value && (await amb.messageCallStatus(messageId))) return
                await snapshot.restore()
            }
            throw new Error('no gas budget produced a strand')
        }

        const makeStrand = async () => {
            const messageId = ethers.keccak256(ethers.toUtf8Bytes(`dispatch-strand-${counter++}`))
            const innerCall = handleNativeCall({
                token: token.target as string,
                recipient: router.target as string,
                value,
                data: feeDirector(stranger.address, unwrapFlag),
            })
            await strand(messageId, innerCall)
            const message = buildMessage({ messageId, sender: mediator.target as string, executor: mediator.target as string, innerCall })
            return { messageId, message }
        }

        it('routes to recovery: full value, no tip, recorded, event fired', async () => {
            const { messageId, message } = await makeStrand()
            expect(await amb.relayedMessages(messageId)).to.equal(true)
            expect(await amb.messageCallStatus(messageId)).to.equal(true)
            expect(await router.processed(messageId)).to.equal(false)
            const signatures = await sign(message, [validators[0], validators[1]])
            const runner = signers[7] // not a validator: recovery needs no runner, and pays it nothing
            const recipientBefore = await hre.ethers.provider.getBalance(stranger)
            const runnerNativeBefore = await hre.ethers.provider.getBalance(runner)
            const runnerWrappedBefore = await token.balanceOf(runner)
            await expect(router.connect(user).safeExecuteSignaturesWithAutoGasLimit(runner, message, signatures))
                .to.emit(router, 'DeliveryRecovered')
                .withArgs(messageId, token.target, router.target, value)
            expect(await hre.ethers.provider.getBalance(stranger)).to.equal(recipientBefore + value)
            expect(await token.balanceOf(router)).to.equal(0n)
            expect(await router.processed(messageId)).to.equal(true)
            expect(await hre.ethers.provider.getBalance(runner)).to.equal(runnerNativeBefore)
            expect(await token.balanceOf(runner)).to.equal(runnerWrappedBefore)
        })

        it('reverts AlreadyProcessed on a second call with the same message', async () => {
            const { message } = await makeStrand()
            const signatures = await sign(message, [validators[0], validators[1]])
            await router.safeExecuteSignaturesWithAutoGasLimit(stranger, message, signatures)
            await expect(router.safeExecuteSignaturesWithAutoGasLimit(stranger, message, signatures)).to.be.revertedWithCustomError(
                router,
                'AlreadyProcessed',
            )
        })

        it('does not reach recovery without validator signatures', async () => {
            const { message, messageId } = await makeStrand()
            const signatures = await sign(message, [validators[0]])
            await expect(router.safeExecuteSignaturesWithAutoGasLimit(stranger, message, signatures)).to.be.revertedWithCustomError(
                router,
                'NotEnoughSignatures',
            )
            expect(await router.processed(messageId)).to.equal(false)
        })
    })
})
