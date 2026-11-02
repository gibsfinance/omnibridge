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
                'RunnerNotValidator',
            ).withArgs(runner.address)
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

        // "Is this message for us?" comes before "has it already been done?". The stub bridge never marks
        // a message relayed, so a message for someone else under an identifier this router already paid
        // has no early exit at all: it must go on to the runner check, never return AlreadyHandled.
        it('a message for another recipient under an identifier this router paid proceeds to the runner check', async () => {
            await router.connect(owner).setValidatorStatus(runner, true)
            const paid = freshMessage(feeDirector(user.address, 0n))
            await router.connect(sender).safeExecuteSignaturesWithAutoGasLimit(runner, paid, '0x')
            const messageId = ethers.keccak256(ethers.toUtf8Bytes('dispatch-fresh'))
            expect(await router.processed(messageId)).to.equal(true)
            expect(await stubMediator.relayedMessages(messageId)).to.equal(false)
            const anotherRecipient = buildMessage({
                messageId,
                sender: stubMediator.target as string,
                executor: stubMediator.target as string,
                innerCall: handleNativeCall({ token: token.target as string, recipient: user.address, value: oneEther, data: feeDirector(user.address, 0n) }),
            })
            await expect(router.connect(sender).safeExecuteSignaturesWithAutoGasLimit(sender, anotherRecipient, '0x'))
                .to.be.revertedWithCustomError(router, 'RunnerNotValidator')
                .withArgs(sender.address)
        })

        // The live bridge always reports the executing message during a callback. A delivery that reads
        // a zero identifier would record nothing and still pay, so a later recovery could pay it again.
        describe('the executing message identifier', () => {
            const callback = () => router.interface.encodeFunctionData('onTokenBridged', [token.target, oneEther, feeDirector(user.address, 0n)])

            it('a delivery that reads a zero identifier reverts and pays nothing', async () => {
                const attempt = stubMediator.execWithMessageId(router, callback(), ethers.ZeroHash)
                await expect(attempt).to.be.reverted
                const revertData = await stubMediator.execWithMessageId
                    .staticCall(router, callback(), ethers.ZeroHash)
                    .then(() => '0x', (error: any) => error.data as string)
                expect(revertData, 'the router names the missing identifier').to.equal(ethers.id('ExecutingMessageIdentifierMissing()').slice(0, 10))
                expect(await token.balanceOf(user)).to.equal(0n)
                expect(await token.balanceOf(router)).to.equal(oneEther)
            })

            it('a delivery records the identifier the bridge reports', async () => {
                const messageId = ethers.keccak256(ethers.toUtf8Bytes('dispatch-identifier'))
                await stubMediator.execWithMessageId(router, callback(), messageId)
                expect(await router.processed(messageId)).to.equal(true)
                expect(await token.balanceOf(user)).to.equal(oneEther)
            })
        })
    })

    // Nothing legitimately sends ether through these: the bridge and the mediator call without value, and
    // the router never forwards value to the bridge. Ether sent to them would only be stuck in the router.
    describe('refuses ether on every function that has no use for it', () => {
        const nonPayableFunctions = ['safeExecuteSignaturesWithAutoGasLimit', 'onTokenBridged', 'setValidatorsFilter', 'setValidatorStatus']
        let token!: any
        let stubMediator!: any
        let router!: any
        let bridgeAccount!: HardhatEthersSigner
        let routerWithAccountBridge!: any
        let runner!: HardhatEthersSigner

        const deploy = async () => {
            signers = await hre.ethers.getSigners()
            ;[owner, , runner, , bridgeAccount] = signers
            token = await (await hre.ethers.getContractFactory('WETH')).deploy()
            stubMediator = await (await hre.ethers.getContractFactory('StubMediator')).deploy(token)
            router = await (await hre.ethers.getContractFactory('TokenOmnibridgeRouter')).deploy(stubMediator, token, owner)
            await router.connect(owner).setValidatorStatus(runner, true)
            await token.deposit({ value: oneEther })
            await token.transfer(router, oneEther)
            // a router whose bridge is a plain account, so the test can call onTokenBridged as the bridge with value
            routerWithAccountBridge = await (await hre.ethers.getContractFactory('TokenOmnibridgeRouter')).deploy(bridgeAccount, token, owner)
        }
        beforeEach(async () => {
            await loadFixture(deploy)
        })

        it('declares each of them nonpayable in the interface', async () => {
            for (const name of nonPayableFunctions) {
                expect(router.interface.getFunction(name)!.stateMutability, name).to.equal('nonpayable')
            }
        })

        it('the entry reverts when sent ether, on a message it would otherwise deliver', async () => {
            const message = buildMessage({
                messageId: ethers.keccak256(ethers.toUtf8Bytes('dispatch-ether')),
                sender: stubMediator.target as string,
                executor: stubMediator.target as string,
                innerCall: handleNativeCall({ token: token.target as string, recipient: router.target as string, value: oneEther, data: feeDirector(owner.address, 0n) }),
            })
            await expect(router.safeExecuteSignaturesWithAutoGasLimit(runner, message, '0x', { value: 1n })).to.be.revertedWithoutReason()
            expect(await hre.ethers.provider.getBalance(router)).to.equal(0n)
        })

        it('onTokenBridged reverts when the bridge sends ether', async () => {
            await expect(
                routerWithAccountBridge.connect(bridgeAccount).onTokenBridged(token, 0n, feeDirector(owner.address, 0n), { value: 1n }),
            ).to.be.revertedWithoutReason()
            expect(await hre.ethers.provider.getBalance(routerWithAccountBridge)).to.equal(0n)
        })

        it('the owner setters revert when sent ether', async () => {
            await expect(router.connect(owner).setValidatorStatus(runner, true, { value: 1n })).to.be.revertedWithoutReason()
            await expect(router.connect(owner).setValidatorsFilter(router, { value: 1n })).to.be.revertedWithoutReason()
            expect(await hre.ethers.provider.getBalance(router)).to.equal(0n)
        })

        it('still accepts ether from the wrapped-coin contract only', async () => {
            await expect(owner.sendTransaction({ to: router.target, value: 1n })).to.be.reverted
            // the unwrap path depends on this: the wrapped-coin contract pays the router on withdraw
            const wrappedCoin = await hre.ethers.getImpersonatedSigner(token.target as string)
            await hre.network.provider.send('hardhat_setBalance', [token.target, ethers.toBeHex(oneEther * 2n)])
            await wrappedCoin.sendTransaction({ to: router.target, value: 1n })
            expect(await hre.ethers.provider.getBalance(router)).to.equal(1n)
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

        it('a second call with the same message returns AlreadyHandled and pays nothing', async () => {
            const { message } = await makeStrand()
            const signatures = await sign(message, [validators[0], validators[1]])
            await router.safeExecuteSignaturesWithAutoGasLimit(stranger, message, signatures)
            const recipientAfter = await hre.ethers.provider.getBalance(stranger)
            expect(await router.connect(user).safeExecuteSignaturesWithAutoGasLimit.staticCall(stranger, message, signatures)).to.equal(2n)
            await expect(router.connect(user).safeExecuteSignaturesWithAutoGasLimit(stranger, message, signatures)).to.not.emit(
                router,
                'DeliveryRecovered',
            )
            expect(await hre.ethers.provider.getBalance(stranger), 'no second payment').to.equal(recipientAfter)
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

    // A fresh delivery through the entry runs inside the relayer's own transaction. The bridge's
    // "safe" mode checks only the mediator's result, and the mediator swallows a failed router
    // callback, so without a check of its own the router could strand the tokens in that very
    // transaction. When the message is for this router, the delivery must be all or nothing.
    describe('fresh message (real mediator): the router delivery is all or nothing', () => {
        const value = oneEther / 10n
        let user!: HardhatEthersSigner
        let runner!: HardhatEthersSigner
        let stranger!: HardhatEthersSigner
        let token!: any
        let mediator!: any
        let router!: any

        const deploy = async () => {
            signers = await hre.ethers.getSigners()
            ;[owner, user, runner, stranger] = signers
            const PermittableToken = await setup.requirePrecompiled('PermittableToken')
            const tokenImage = await PermittableToken.deploy('TEST', 'TST', 18, 1337)
            const tokenFactory = await (await hre.ethers.getContractFactory('TokenFactory')).deploy(owner, tokenImage)
            mediator = await (await hre.ethers.getContractFactory('ForeignOmnibridge')).deploy(' on Testnet')
            const bridgeValidators = await (await hre.ethers.getContractFactory('BridgeValidators')).deploy()
            await bridgeValidators.initialize(1, [owner.address], owner)
            const amb = await (await hre.ethers.getContractFactory('AMBMock')).deploy(bridgeValidators)
            await mediator.initialize(amb, mediator, [oneEther * 100n, oneEther * 10n, 1n], [oneEther * 100n, oneEther * 10n], 1000000, owner, tokenFactory)
            token = await (await hre.ethers.getContractFactory('WETH')).deploy()
            router = await (await hre.ethers.getContractFactory('TokenOmnibridgeRouter')).deploy(mediator, token, owner)
            await router.connect(owner).setValidatorStatus(runner, true)
            await router.connect(user).getFunction('wrapAndRelayTokens()')({ value: oneEther })
        }
        beforeEach(async () => {
            await loadFixture(deploy)
        })

        const messageFor = (recipient: string, gas: bigint) =>
            buildMessage({
                messageId: ethers.keccak256(ethers.toUtf8Bytes('dispatch-fresh-real')),
                sender: mediator.target as string,
                executor: mediator.target as string,
                gas,
                innerCall: handleNativeCall({ token: token.target as string, recipient, value, data: feeDirector(stranger.address, 0n) }),
            })

        it('no message gas budget strands the tokens: each run delivers in full or reverts DeliveryNotCompleted', async () => {
            const outcomes = { delivered: 0, deliveryNotCompleted: 0, otherRevert: 0, stranded: 0 }
            for (let gas = 60_000n; gas < 400_000n; gas += 2_000n) {
                const snapshot = await takeSnapshot()
                const message = messageFor(router.target as string, gas)
                const dryRun = await router
                    .connect(user)
                    .safeExecuteSignaturesWithAutoGasLimit.staticCall(runner, message, '0x', { gasLimit: 8_000_000n })
                    .then(
                        () => 'ok',
                        (error: any) => router.interface.parseError(error.data ?? '0x')?.name ?? 'other',
                    )
                if (dryRun === 'DeliveryNotCompleted') outcomes.deliveryNotCompleted++
                if (dryRun !== 'ok' && dryRun !== 'DeliveryNotCompleted') outcomes.otherRevert++
                if (dryRun === 'ok') {
                    const strangerBefore = await token.balanceOf(stranger)
                    await router.connect(user).safeExecuteSignaturesWithAutoGasLimit(runner, message, '0x', { gasLimit: 8_000_000n })
                    const deliveredInFull =
                        (await token.balanceOf(stranger)) - strangerBefore === value && (await token.balanceOf(router)) === 0n
                    if (deliveredInFull) outcomes.delivered++
                    if (!deliveredInFull) outcomes.stranded++
                }
                await snapshot.restore()
            }
            console.log(`      outcomes over the sweep: ${JSON.stringify(outcomes)}`)
            expect(outcomes.stranded, 'no budget leaves the tokens stranded').to.equal(0)
            expect(outcomes.deliveryNotCompleted, 'some budget reached the router check').to.be.greaterThan(0)
            expect(outcomes.delivered, 'ample budgets deliver').to.be.greaterThan(0)
        })

        it('does not apply the check to a message for another recipient', async () => {
            // An address with no code gets no callback, so the router records nothing for it.
            const message = messageFor(stranger.address, 2_000_000n)
            await router.connect(user).safeExecuteSignaturesWithAutoGasLimit(runner, message, '0x')
            expect(await token.balanceOf(stranger)).to.equal(value)
            expect(await router.processed(ethers.keccak256(ethers.toUtf8Bytes('dispatch-fresh-real')))).to.equal(false)
        })
    })
})
