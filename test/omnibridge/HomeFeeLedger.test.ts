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

export const instruction = (recipient: string, partnerId = 0n, maximumTotalRate = 10_000n, unwrap = false) =>
    coder.encode(['address', 'uint256', 'uint16', 'bool'], [recipient, partnerId, maximumTotalRate, unwrap])

describe('HomeFeeLedger', () => {
    let owner!: HardhatEthersSigner
    let collector!: HardhatEthersSigner
    let controller!: HardhatEthersSigner
    let payout!: HardhatEthersSigner
    let user!: HardhatEthersSigner
    let recipient!: HardhatEthersSigner
    let stranger!: HardhatEthersSigner
    let mediator: any
    let otherMediator: any
    let ledger: any
    let token: any
    let wNative: any

    const deploy = async () => {
        ;[owner, collector, controller, payout, user, recipient, stranger] = await hre.ethers.getSigners()
        mediator = await (await hre.ethers.getContractFactory('MockHomeMediator')).deploy()
        otherMediator = await (await hre.ethers.getContractFactory('MockHomeMediator')).deploy()
        wNative = await (await hre.ethers.getContractFactory('WETH')).deploy()
        token = await (await hre.ethers.getContractFactory('MockLedgerToken')).deploy()
        ledger = await (await hre.ethers.getContractFactory('HomeFeeLedger')).deploy(
            [mediator, otherMediator], wNative, collector, owner, 30,
        )
    }

    beforeEach(async () => {
        await loadFixture(deploy)
    })

    const deliver = async (data: string, transferred = amount, value = amount, from = mediator, asset = token) => {
        await asset.mint(from, transferred)
        return from.deliver(asset, ledger, transferred, value, data)
    }
    const registerPartner = async (rate: number, signer = controller) => {
        await ledger.connect(signer).registerPartner(payout, rate)
        return await ledger.partnerCount()
    }
    const ledgerBalance = (asset = token) => asset.balanceOf(ledger)

    describe('construction', () => {
        it('fixes constants, mediators and collector', async () => {
            expect(await ledger.MAXIMUM_GIBS_RATE()).to.equal(100)
            expect(await ledger.MAXIMUM_PARTNER_RATE()).to.equal(100)
            expect(await ledger.isMediator(mediator)).to.equal(true)
            expect(await ledger.isMediator(otherMediator)).to.equal(true)
            expect(await ledger.isMediator(stranger)).to.equal(false)
            expect(await ledger.gibsCollector()).to.equal(collector.address)
            expect(await ledger.gibsRate()).to.equal(30)
        })
        it('rejects bad arguments', async () => {
            const factory = await hre.ethers.getContractFactory('HomeFeeLedger')
            await expect(factory.deploy([], wNative, collector, owner, 0)).to.be.revertedWithCustomError(ledger, 'NoMediators')
            await expect(factory.deploy([ZERO], wNative, collector, owner, 0)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
            await expect(factory.deploy([mediator], ZERO, collector, owner, 0)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
            await expect(factory.deploy([mediator], wNative, ZERO, owner, 0)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
            await expect(factory.deploy([mediator], wNative, collector, ZERO, 0)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
            await expect(factory.deploy([mediator], wNative, collector, owner, 101)).to.be.revertedWithCustomError(ledger, 'RateTooHigh')
        })
    })

    describe('admin', () => {
        it('sets the gibs rate up to the ceiling only', async () => {
            await ledger.setGibsRate(100)
            expect(await ledger.gibsRate()).to.equal(100)
            await expect(ledger.setGibsRate(101)).to.be.revertedWithCustomError(ledger, 'RateTooHigh')
            await expect(ledger.connect(stranger).setGibsRate(1)).to.be.revertedWithCustomError(ledger, 'NotAdmin')
        })
        it('moves the role in two steps', async () => {
            await expect(ledger.transferAdmin(ZERO)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
            await expect(ledger.connect(stranger).transferAdmin(stranger)).to.be.revertedWithCustomError(ledger, 'NotAdmin')
            await ledger.transferAdmin(user)
            expect(await ledger.admin()).to.equal(owner.address)
            await expect(ledger.connect(stranger).acceptAdmin()).to.be.revertedWithCustomError(ledger, 'NotPendingAdmin')
            await ledger.connect(user).acceptAdmin()
            expect(await ledger.admin()).to.equal(user.address)
            expect(await ledger.pendingAdmin()).to.equal(ZERO)
            await expect(ledger.setGibsRate(1)).to.be.revertedWithCustomError(ledger, 'NotAdmin')
        })
        it('renounces for good', async () => {
            await ledger.renounceAdmin()
            expect(await ledger.admin()).to.equal(ZERO)
            await expect(ledger.setGibsRate(1)).to.be.revertedWithCustomError(ledger, 'NotAdmin')
            await expect(ledger.rescueUnaccounted(token, owner)).to.be.revertedWithCustomError(ledger, 'NotAdmin')
        })
    })

    describe('partners', () => {
        it('registers from id 1 and records the controller', async () => {
            await expect(ledger.connect(controller).registerPartner(payout, 50))
                .to.emit(ledger, 'PartnerRegistered').withArgs(1n, controller.address, payout.address, 50n)
            const partner = await ledger.partners(1)
            expect(partner.controller).to.equal(controller.address)
            expect(partner.payout).to.equal(payout.address)
            expect(partner.rate).to.equal(50)
            expect(await ledger.partnerCount()).to.equal(1)
        })
        it('rejects a zero payout and a rate above the ceiling', async () => {
            await expect(ledger.registerPartner(ZERO, 1)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
            await expect(ledger.registerPartner(payout, 101)).to.be.revertedWithCustomError(ledger, 'RateTooHigh')
        })
        it('lets only the controller change payout and rate', async () => {
            const id = await registerPartner(10)
            await expect(ledger.connect(stranger).setPartnerPayout(id, stranger)).to.be.revertedWithCustomError(ledger, 'NotPartnerController')
            await expect(ledger.connect(owner).setPartnerRate(id, 1)).to.be.revertedWithCustomError(ledger, 'NotPartnerController')
            await expect(ledger.connect(owner).transferPartnerControl(id, owner)).to.be.revertedWithCustomError(ledger, 'NotPartnerController')
            await ledger.connect(controller).setPartnerPayout(id, user)
            await ledger.connect(controller).setPartnerRate(id, 100)
            await expect(ledger.connect(controller).setPartnerRate(id, 101)).to.be.revertedWithCustomError(ledger, 'RateTooHigh')
            await expect(ledger.connect(controller).setPartnerPayout(id, ZERO)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
            const partner = await ledger.partners(id)
            expect(partner.payout).to.equal(user.address)
            expect(partner.rate).to.equal(100)
        })
        it('gives the admin no power over a partner', async () => {
            const id = await registerPartner(10)
            await expect(ledger.connect(owner).setPartnerRate(id, 0)).to.be.revertedWithCustomError(ledger, 'NotPartnerController')
            await expect(ledger.connect(owner).setPartnerPayout(id, owner)).to.be.revertedWithCustomError(ledger, 'NotPartnerController')
        })
        it('moves control in two steps', async () => {
            const id = await registerPartner(10)
            await expect(ledger.connect(controller).transferPartnerControl(id, ZERO)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
            await ledger.connect(controller).transferPartnerControl(id, user)
            await expect(ledger.connect(stranger).acceptPartnerControl(id)).to.be.revertedWithCustomError(ledger, 'NotPendingPartnerController')
            expect((await ledger.partners(id)).controller).to.equal(controller.address)
            await ledger.connect(user).acceptPartnerControl(id)
            expect((await ledger.partners(id)).controller).to.equal(user.address)
            await expect(ledger.connect(controller).setPartnerRate(id, 1)).to.be.revertedWithCustomError(ledger, 'NotPartnerController')
            await ledger.connect(user).setPartnerRate(id, 1)
        })
    })

    describe('inbound', () => {
        it('splits with a partner and pays the rest', async () => {
            const id = await registerPartner(50)
            await deliver(instruction(recipient.address, id))
            expect(await token.balanceOf(recipient)).to.equal(amount - 3_000n - 5_000n)
            expect(await ledger.owed(token, collector)).to.equal(3_000n)
            expect(await ledger.owed(token, payout)).to.equal(5_000n)
            expect(await ledger.totalOwed(token)).to.equal(8_000n)
            expect(await ledgerBalance()).to.equal(8_000n)
            expect(await mediator.lastCallbackSucceeded()).to.equal(true)
        })
        it('splits without a partner', async () => {
            await deliver(instruction(recipient.address))
            expect(await token.balanceOf(recipient)).to.equal(amount - 3_000n)
            expect(await ledger.owed(token, collector)).to.equal(3_000n)
            expect(await ledger.totalOwed(token)).to.equal(3_000n)
        })
        it('treats an unknown partner as no partner', async () => {
            await registerPartner(50)
            await deliver(instruction(recipient.address, 2n))
            expect(await token.balanceOf(recipient)).to.equal(amount - 3_000n)
            await deliver(instruction(recipient.address, ethers.MaxUint256))
            expect(await mediator.lastCallbackSucceeded()).to.equal(true)
            expect(await ledger.totalOwed(token)).to.equal(6_000n)
        })
        it('accepts every mediator on the list', async () => {
            await deliver(instruction(recipient.address), amount, amount, otherMediator)
            expect(await token.balanceOf(recipient)).to.equal(amount - 3_000n)
        })
        it('caps an over-ceiling total and cuts the partner fee first', async () => {
            await ledger.setGibsRate(100)
            const id = await registerPartner(100)
            // maximum 150: gibs keeps 100, partner is cut from 100 to 50
            await deliver(instruction(recipient.address, id, 150n))
            expect(await ledger.owed(token, collector)).to.equal(10_000n)
            expect(await ledger.owed(token, payout)).to.equal(5_000n)
            // maximum 80: partner is cut to zero, then gibs is cut from 100 to 80
            await deliver(instruction(recipient.address, id, 80n))
            expect(await ledger.owed(token, collector)).to.equal(10_000n + 8_000n)
            expect(await ledger.owed(token, payout)).to.equal(5_000n)
            // maximum 0: nothing is charged
            await deliver(instruction(recipient.address, id, 0n))
            expect(await ledger.totalOwed(token)).to.equal(23_000n)
            expect(await token.balanceOf(recipient)).to.equal(
                (amount - 15_000n) + (amount - 8_000n) + amount,
            )
        })
        it('leaves tokens unaccounted when data is too short or too long, without reverting', async () => {
            const good = instruction(recipient.address)
            for (const bad of ['0x', good.slice(0, -2), good + '00', good + '00'.repeat(32)]) {
                await expect(deliver(bad)).to.emit(ledger, 'Skipped')
                expect(await mediator.lastCallbackSucceeded()).to.equal(true)
            }
            expect(await ledger.totalOwed(token)).to.equal(0n)
            expect(await ledgerBalance()).to.equal(amount * 4n)
            expect(await token.balanceOf(recipient)).to.equal(0n)
        })
        it('leaves tokens unaccounted when a word holds bits its type cannot', async () => {
            const dirtyAddress = '0x' + 'ff'.repeat(12) + recipient.address.slice(2) + instruction(recipient.address).slice(66)
            const dirtyRate = instruction(recipient.address, 0n, 0n).slice(0, 2 + 64 * 2) + '00'.repeat(29) + '010000' + '00'.repeat(31) + '00'
            const dirtyBool = instruction(recipient.address).slice(0, -2) + '02'
            for (const bad of [dirtyAddress, dirtyRate, dirtyBool]) {
                expect(bad.length).to.equal(2 + 256)
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
            await ledger.rescueUnaccounted(token, stranger)
            expect(await token.balanceOf(stranger)).to.equal(amount)
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
            await mediator.deliver(wNative, ledger, amount, amount, instruction(recipient.address, 0n, 10_000n, true))
            expect(await hre.ethers.provider.getBalance(recipient)).to.equal(before + amount - 3_000n)
            expect(await ledger.owed(wNative, collector)).to.equal(3_000n)
            expect(await wNative.balanceOf(ledger)).to.equal(3_000n)
            expect(await hre.ethers.provider.getBalance(ledger)).to.equal(0n)
        })
        it('credits wrapped tokens, not native coin, when the recipient rejects native coin', async () => {
            const rejecting = await (await hre.ethers.getContractFactory('MockPayoutReceiver')).deploy()
            await wNative.deposit({ value: amount })
            await wNative.transfer(mediator, amount)
            await mediator.deliver(wNative, ledger, amount, amount, instruction(await rejecting.getAddress(), 0n, 10_000n, true))
            expect(await mediator.lastCallbackSucceeded()).to.equal(true)
            expect(await ledger.owed(wNative, rejecting)).to.equal(amount - 3_000n)
            expect(await ledger.owed(ZERO, rejecting)).to.equal(0n)
            expect(await wNative.balanceOf(ledger)).to.equal(amount)
            expect(await hre.ethers.provider.getBalance(ledger)).to.equal(0n)
        })
        it('pays wrapped tokens when unwrap is set for another token', async () => {
            await deliver(instruction(recipient.address, 0n, 10_000n, true))
            expect(await token.balanceOf(recipient)).to.equal(amount - 3_000n)
        })
        it('skips instead of reverting on a reentrant delivery', async () => {
            const reentrant = await (await hre.ethers.getContractFactory('MockReentrantMediator')).deploy()
            const guarded = await (await hre.ethers.getContractFactory('HomeFeeLedger')).deploy(
                [mediator, reentrant], wNative, collector, owner, 30,
            )
            await reentrant.setTarget(guarded)
            await wNative.deposit({ value: amount })
            await wNative.transfer(mediator, amount)
            const data = instruction(await reentrant.getAddress(), 0n, 10_000n, true)
            await expect(mediator.deliver(wNative, guarded, amount, amount, data))
                .to.emit(guarded, 'Skipped').withArgs(reentrant, reentrant, 1n, SkipReason.Reentrant)
            expect(await reentrant.reentrantCallSucceeded()).to.equal(true)
        })
        it('rejects a caller that is not a mediator', async () => {
            await expect(ledger.connect(stranger).onTokenBridged(token, amount, instruction(recipient.address)))
                .to.be.revertedWithCustomError(ledger, 'NotMediator')
        })
    })

    describe('ledger', () => {
        it('lets each account withdraw its own balance, for tokens', async () => {
            const id = await registerPartner(50)
            await deliver(instruction(recipient.address, id))
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
            await expect(ledger.rescueUnaccounted(token, owner)).to.be.revertedWithCustomError(ledger, 'NothingToPay')
            await token.mint(ledger, 777n)
            await expect(ledger.connect(stranger).rescueUnaccounted(token, stranger)).to.be.revertedWithCustomError(ledger, 'NotAdmin')
            await expect(ledger.rescueUnaccounted(token, ZERO)).to.be.revertedWithCustomError(ledger, 'ZeroAddress')
            await ledger.rescueUnaccounted(token, owner)
            expect(await token.balanceOf(owner)).to.equal(777n)
            expect(await ledgerBalance()).to.equal(3_000n)
            expect(await ledger.owed(token, collector)).to.equal(3_000n)
            await ledger.connect(collector).withdraw(token)
            expect(await token.balanceOf(collector)).to.equal(3_000n)
        })
        it('refuses native coin from anyone but the wrapped token', async () => {
            await expect(stranger.sendTransaction({ to: ledger, value: 1n })).to.be.revertedWithCustomError(ledger, 'SenderNotWrappedNative')
        })
        it('rescues native coin that arrived by force, and nothing else', async () => {
            await hre.network.provider.send('hardhat_setBalance', [await ledger.getAddress(), '0x64'])
            await expect(ledger.rescueUnaccounted(ZERO, stranger)).to.changeEtherBalances([ledger, stranger], [-100n, 100n])
            await expect(ledger.rescueUnaccounted(ZERO, stranger)).to.be.revertedWithCustomError(ledger, 'NothingToPay')
        })
        it('withdraws a native entry with a call', async () => {
            // no code path credits native coin today, so plant owed (slot 6) and totalOwed (slot 7) entries
            const owedSlot = ethers.keccak256(coder.encode(['address', 'bytes32'], [user.address,
                ethers.keccak256(coder.encode(['address', 'uint256'], [ZERO, 6]))]))
            const totalSlot = ethers.keccak256(coder.encode(['address', 'uint256'], [ZERO, 7]))
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
        beforeEach(async () => {
            await token.mint(user, amount * 10n)
            await token.connect(user).approve(ledger, ethers.MaxUint256)
        })

        it('takes fees and bridges the rest with data unchanged', async () => {
            const id = await registerPartner(50)
            const data = '0x1234abcd'
            await expect(ledger.connect(user).relay(mediator, token, amount, toForeign, data, id, 80))
                .to.emit(mediator, 'TokensBridgingInitiated')
                .withArgs(token, ledger, amount - 8_000n, toForeign, data)
            expect(await token.balanceOf(mediator)).to.equal(amount - 8_000n)
            expect(await ledger.owed(token, collector)).to.equal(3_000n)
            expect(await ledger.owed(token, payout)).to.equal(5_000n)
            expect(await ledgerBalance()).to.equal(8_000n)
            expect(await token.allowance(ledger, mediator)).to.equal(0n)
        })
        it('measures the amount received for a fee-on-transfer token', async () => {
            await token.setFeeBasisPoints(100) // 1% burnt on every transfer
            // user -> ledger: 990_000 arrives. fee 0.3% of that = 2_970. The mediator then pulls the rest.
            await ledger.connect(user).relay(mediator, token, amount, toForeign, '0x', 0, 30)
            const events = await helpers.getEvents(mediator, 'TokensBridgingInitiated')
            expect(events[0].args.value).to.equal(990_000n - 2_970n)
            expect(await ledger.owed(token, collector)).to.equal(2_970n)
            expect(await ledger.totalOwed(token)).to.equal(2_970n)
        })
        it('reverts when the rates exceed the caller maximum', async () => {
            const id = await registerPartner(50)
            await expect(ledger.connect(user).relay(mediator, token, amount, toForeign, '0x', id, 79))
                .to.be.revertedWithCustomError(ledger, 'RateAboveMaximum')
            await expect(ledger.connect(user).relay(mediator, token, amount, toForeign, '0x', 0, 29))
                .to.be.revertedWithCustomError(ledger, 'RateAboveMaximum')
        })
        it('reverts for an unknown partner', async () => {
            await expect(ledger.connect(user).relay(mediator, token, amount, toForeign, '0x', 1, 200))
                .to.be.revertedWithCustomError(ledger, 'UnknownPartner')
        })
        it('reverts for a mediator that is not on the list', async () => {
            await expect(ledger.connect(user).relay(stranger, token, amount, toForeign, '0x', 0, 200))
                .to.be.revertedWithCustomError(ledger, 'NotMediator')
            await expect(ledger.connect(user).relayNative(stranger, toForeign, '0x', 0, 200, { value: amount }))
                .to.be.revertedWithCustomError(ledger, 'NotMediator')
        })
        it('reverts when nothing is received', async () => {
            await expect(ledger.connect(user).relay(mediator, token, 0, toForeign, '0x', 0, 200))
                .to.be.revertedWithCustomError(ledger, 'NothingReceived')
        })
        it('wraps native coin and bridges the rest', async () => {
            const id = await registerPartner(50)
            await expect(ledger.connect(user).relayNative(mediator, toForeign, '0xbeef', id, 80, { value: amount }))
                .to.emit(mediator, 'TokensBridgingInitiated')
                .withArgs(wNative, ledger, amount - 8_000n, toForeign, '0xbeef')
            expect(await wNative.balanceOf(mediator)).to.equal(amount - 8_000n)
            expect(await ledger.owed(wNative, collector)).to.equal(3_000n)
            expect(await ledger.owed(wNative, payout)).to.equal(5_000n)
            expect(await hre.ethers.provider.getBalance(ledger)).to.equal(0n)
        })
    })
})
