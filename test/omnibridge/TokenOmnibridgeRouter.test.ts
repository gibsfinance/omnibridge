import hre from 'hardhat'
import { loadFixture, setNextBlockBaseFeePerGas } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import * as helpers from '../helpers/helpers'
import * as setup from '../setup'
import * as ethers from 'ethers'
import { AMBMock, ForeignOmnibridge, StubMediator, WETH, TokenOmnibridgeRouter__factory, IERC20 } from '../../artifacts/types'
import { TokenOmnibridgeRouter } from '../../artifacts/types/contracts/helpers/TokenOmnibridgeRouter'

const oneEther = ethers.parseEther('1')
const dailyLimit = ethers.parseEther('2.5')
const maxPerTx = oneEther
const minPerTx = ethers.parseEther('0.01')
const executionDailyLimit = dailyLimit
const executionMaxPerTx = maxPerTx
describe('TokenOmnibridgeRouter', () => {
    let token!: WETH
    let token2!: IERC20
    let mediator!: ForeignOmnibridge
    let TokenOmnibridgeRouter!: TokenOmnibridgeRouter__factory
    let ambBridgeContract!: AMBMock
    let signers!: ethers.Signer[]
    let owner!: ethers.Signer
    let user!: ethers.Signer
    let v1!: ethers.Signer
    let v2!: ethers.Signer
    const deployContracts = async () => {
        signers = await hre.ethers.getSigners()
        owner = signers[0]
        user = signers[1]
        v1 = signers[2]
        v2 = signers[3]
        const PermittableToken = await setup.requirePrecompiled('PermittableToken')
        const ForeignOmnibridge = await hre.ethers.getContractFactory('ForeignOmnibridge')
        TokenOmnibridgeRouter = await hre.ethers.getContractFactory('TokenOmnibridgeRouter')
        const AMBMock = await hre.ethers.getContractFactory('AMBMock')
        const WETH = await hre.ethers.getContractFactory('WETH')
        const TokenFactory = await hre.ethers.getContractFactory('TokenFactory')
        const tokenImage = await PermittableToken.deploy('TEST', 'TST', 18, 1337)
        const tokenFactory = await TokenFactory.deploy(owner, tokenImage)
        mediator = await ForeignOmnibridge.deploy(' on Testnet')
        const BridgeValidators = await hre.ethers.getContractFactory('BridgeValidators')
        const bridgeValidators = await BridgeValidators.deploy()
        ambBridgeContract = await AMBMock.deploy(bridgeValidators)
        await mediator.initialize(ambBridgeContract, mediator, [dailyLimit, maxPerTx, minPerTx], [executionDailyLimit, executionMaxPerTx], 1000000, owner, tokenFactory)
        token = await WETH.deploy()
        token2 = await WETH.deploy()
    }

    beforeEach(async () => {
        await loadFixture(deployContracts)
    })

    it('wrapAndRelayTokens', async () => {
        const value = oneEther
        const WETHRouter = await TokenOmnibridgeRouter.deploy(mediator, token, owner, true)
        const method1 = WETHRouter.connect(user).getFunction('wrapAndRelayTokens()')
        const method2 = WETHRouter.connect(user).getFunction('wrapAndRelayTokens(address)')
        await expect(method1({ value: value })).to.be.fulfilled
        await expect(method2(signers[2], { value: value })).to.be.fulfilled
        // this call rejects because it hits the limit for the default signer
        await expect(method1({ value: value })).to.be.rejected
        const depositEvents = await helpers.getEvents(mediator, 'TokensBridgingInitiated')
        expect(depositEvents.length).to.be.equal(2)
        for (const event of depositEvents) {
            expect(event.args.token).to.be.equal(await token.getAddress())
            expect(event.args.sender).to.be.equal(await WETHRouter.getAddress())
            expect(event.args.value).to.be.equal(value)
            expect(event.args.messageId).to.include('0x11223344')
        }
        const ambEvents = await helpers.getEvents(ambBridgeContract, 'MockedEvent')
        expect(ambEvents.length).to.be.equal(2)
        expect(ambEvents[0].args.data).to.include((await user.getAddress()).slice(2).toLowerCase())
        expect(ambEvents[1].args.data).to.include((await signers[2].getAddress()).slice(2).toLowerCase())
    })

    it('onTokenBridged', async () => {
        const stubMediator = signers[2]
        const WETHRouter = await TokenOmnibridgeRouter.deploy(stubMediator, token, owner, true)
        const value = oneEther / 100n
        await token.deposit({ value: value })
        await expect(token.transfer(WETHRouter, value)).to.be.fulfilled
        const balanceBefore = await hre.ethers.provider.getBalance(user)
        await expect(WETHRouter.connect(stubMediator).onTokenBridged(owner, value, await user.getAddress())).to.be.rejected
        await expect(WETHRouter.connect(stubMediator).onTokenBridged(token, value, '0x')).to.be.rejected
        await expect(WETHRouter.connect(owner).onTokenBridged(token, value, await user.getAddress())).to.be.rejected
        await expect(WETHRouter.connect(stubMediator).onTokenBridged(token, value, await user.getAddress())).to.be.fulfilled
        const balanceAfter = await hre.ethers.provider.getBalance(user)
        expect(balanceAfter).to.be.equal(balanceBefore + value)
    })

    it('claimTokens', async () => {
        const WETHRouter = await TokenOmnibridgeRouter.deploy(mediator, token, owner, true)
        const value = oneEther / 100n
        await token.deposit({ value: value })
        await expect(token.transfer(WETHRouter, value)).to.be.fulfilled
        await expect(WETHRouter.connect(user).claimTokens(token, user)).to.be.rejected
        await expect(WETHRouter.connect(owner).claimTokens(token, user)).to.be.fulfilled
        await expect(token.balanceOf(user))
            .eventually.to.be.equal(value.toString())
    })

    describe('alt pathway', () => {
        const value = oneEther

        describe('err conditions', () => {
            let WETHRouter!: TokenOmnibridgeRouter
            let stubMediator!: ethers.Signer

            beforeEach(async () => {
                stubMediator = signers[2]
                WETHRouter = await TokenOmnibridgeRouter.deploy(stubMediator, token, owner, true)
                await token.deposit({ value })
                await expect(token.transfer(WETHRouter, value)).to.be.fulfilled
            })

            it('when bad struct data is provided', async () => {
                // such as a missing recipient
                const badData = hre.ethers.AbiCoder.defaultAbiCoder().encode(
                    ['uint256'],
                    [1n],
                )
                await expect(WETHRouter.connect(stubMediator).onTokenBridged(token, value, badData)).to.be.rejected
            })
        })

        describe('mediator', () => {
            let WETHRouter!: TokenOmnibridgeRouter
            let stubMediator!: StubMediator

            beforeEach(async () => {
                const StubMediator = await hre.ethers.getContractFactory('StubMediator')
                stubMediator = await StubMediator.deploy(token)
                WETHRouter = await TokenOmnibridgeRouter.deploy(stubMediator, token, owner, true)
                await token.deposit({ value })
                await (token2 as WETH).deposit({ value })
                await token.transfer(WETHRouter, value)
                await expect(token2.transfer(WETHRouter, value)).to.be.fulfilled
            })

            it('can call onTokenBridged directly', async () => {
                const data = hre.ethers.AbiCoder.defaultAbiCoder().encode(
                    ['address', 'bool', 'uint256', 'uint256'],
                    [await user.getAddress(), false, oneEther, oneEther / 10n],
                )
                await stubMediator.exec(WETHRouter, WETHRouter.interface.encodeFunctionData('onTokenBridged', [
                    await token.getAddress(),
                    value, // after bridge fees value
                    data,
                ]))
            })
            it('transfers the appropriate fees to the runner', async () => {
                const data = hre.ethers.AbiCoder.defaultAbiCoder().encode(
                    ['address', 'uint256', 'uint256', 'uint256'],
                    [await user.getAddress(), 0b010, oneEther, oneEther / 10n],
                )
                await expect(WETHRouter.connect(v2).safeExecuteSignaturesWithAutoGasLimit(v1, data, '0x'))
                    .to.revertedWithCustomError(WETHRouter, 'NotPayable')
                // no event emitted
                await expect(WETHRouter.isValidator(v1)).eventually.to.equal(false)
                await WETHRouter.connect(owner).setValidatorStatus(v1, true)
                await expect(WETHRouter.isValidator(v1)).eventually.to.equal(true)
                // data input would not look like this, it would have a receiver and other things
                // sig list is empty because this is a test - none of the other tests go this far
                const nextBaseFee = 1_000n
                await setNextBlockBaseFeePerGas(nextBaseFee)
                const snap = async (addr: ethers.Addressable) => ({
                    balance: await hre.ethers.provider.getBalance(addr),
                    weth: await token.balanceOf(addr),
                })
                const [wethRouterBefore, userBefore, v1Before, v2Before] = await Promise.all([WETHRouter, user, v1, v2].map(snap))
                const tx = await WETHRouter.connect(v2).safeExecuteSignaturesWithAutoGasLimit(v1, data, '0x', {
                    maxPriorityFeePerGas: 0,
                })
                const receipt = await tx.wait()
                const [wethRouterAfter, userAfter, v1After, v2After] = await Promise.all([WETHRouter, user, v1, v2].map(snap))
                const gasUsed = receipt!.gasUsed
                const txFees = gasUsed * nextBaseFee
                expect(v2Before.balance).to.equal(v2After.balance + txFees, 'tx runner has his native token reduced to pay for gas')
                expect(v2Before.weth).to.equal(v2After.weth, 'tx runner does not have any weth modified')
                expect(userBefore.balance).to.be.lessThan(userAfter.balance)
                const userDelta = userAfter.balance - userBefore.balance
                expect(userDelta).to.be.lessThan(oneEther)
                expect(userDelta).to.be.greaterThan(oneEther * 99n / 100n, 'vast majority is maintained (based on base fee)')
                expect(v1Before.balance).to.be.lessThan(v1After.balance)
                const actionFees = v1After.balance - v1Before.balance
                expect(wethRouterBefore.balance).to.equal(wethRouterAfter.balance)
                expect(wethRouterBefore.weth).to.equal(wethRouterAfter.weth + userDelta + actionFees)
            })
            it('can transfer wrapped native to the runner', async () => {
                const data = hre.ethers.AbiCoder.defaultAbiCoder().encode(
                    ['address', 'uint256', 'uint256', 'uint256'],
                    [await user.getAddress(), 0b100, oneEther, oneEther / 10n],
                )
                await expect(WETHRouter.connect(v2).safeExecuteSignaturesWithAutoGasLimit(v1, data, '0x'))
                    .to.revertedWithCustomError(WETHRouter, 'NotPayable')
                // no event emitted
                await expect(WETHRouter.isValidator(v1)).eventually.to.equal(false)
                await WETHRouter.connect(owner).setValidatorStatus(v1, true)
                await expect(WETHRouter.isValidator(v1)).eventually.to.equal(true)
                // data input would not look like this, it would have a receiver and other things
                // sig list is empty because this is a test - none of the other tests go this far
                const nextBaseFee = 1_000n
                await setNextBlockBaseFeePerGas(nextBaseFee)
                const snap = async (addr: ethers.Addressable) => ({
                    balance: await hre.ethers.provider.getBalance(addr),
                    weth: await token.balanceOf(addr),
                })
                const [wethRouterBefore, userBefore, v1Before, v2Before] = await Promise.all([WETHRouter, user, v1, v2].map(snap))
                const tx = await WETHRouter.connect(v2).safeExecuteSignaturesWithAutoGasLimit(v1, data, '0x', {
                    maxPriorityFeePerGas: 0,
                })
                const receipt = await tx.wait()
                const [wethRouterAfter, userAfter, v1After, v2After] = await Promise.all([WETHRouter, user, v1, v2].map(snap))
                const gasUsed = receipt!.gasUsed
                const txFees = gasUsed * nextBaseFee
                expect(v2Before.balance).to.equal(v2After.balance + txFees, 'tx runner has his native token reduced to pay for gas')
                expect(v2Before.weth).to.equal(v2After.weth, 'tx runner does not have any weth modified')
                expect(userBefore.balance).to.be.equal(userAfter.balance)
                expect(userBefore.weth).to.be.lessThan(userAfter.weth)
                const userDelta = userAfter.weth - userBefore.weth
                expect(userDelta).to.be.lessThan(oneEther)
                expect(userDelta).to.be.greaterThan(oneEther * 99n / 100n, 'vast majority is maintained (based on base fee)')
                expect(v1Before.balance).to.be.equal(v1After.balance)
                expect(v1Before.weth).to.be.lessThan(v1After.weth)
                const actionFees = v1After.weth - v1Before.weth
                expect(wethRouterBefore.balance).to.equal(wethRouterAfter.balance)
                expect(wethRouterBefore.weth).to.equal(wethRouterAfter.weth + userDelta + actionFees)
            })
            it('can transfer any token to the runner', async () => {
                // even thought this data does request an unwrap, the unwrap will not occur
                const data = hre.ethers.AbiCoder.defaultAbiCoder().encode(
                    ['address', 'uint256', 'uint256', 'uint256'],
                    [await user.getAddress(), 0b110, oneEther, oneEther / 10n],
                )
                await stubMediator.setToken(token2)
                await expect(WETHRouter.connect(v2).safeExecuteSignaturesWithAutoGasLimit(v1, data, '0x'))
                    .to.revertedWithCustomError(WETHRouter, 'NotPayable')
                // no event emitted
                await expect(WETHRouter.isValidator(v1)).eventually.to.equal(false)
                await WETHRouter.connect(owner).setValidatorStatus(v1, true)
                await expect(WETHRouter.isValidator(v1)).eventually.to.equal(true)
                // data input would not look like this, it would have a receiver and other things
                // sig list is empty because this is a test - none of the other tests go this far
                const nextBaseFee = 1_000n
                await setNextBlockBaseFeePerGas(nextBaseFee)
                const snap = async (addr: ethers.Addressable) => ({
                    balance: await hre.ethers.provider.getBalance(addr),
                    weth: await token.balanceOf(addr),
                    token2: await token2.balanceOf(addr),
                })
                const [wethRouterBefore, userBefore, v1Before, v2Before] = await Promise.all([WETHRouter, user, v1, v2].map(snap))
                const tx = await WETHRouter.connect(v2).safeExecuteSignaturesWithAutoGasLimit(v1, data, '0x', {
                    maxPriorityFeePerGas: 0,
                })
                const receipt = await tx.wait()
                const [wethRouterAfter, userAfter, v1After, v2After] = await Promise.all([WETHRouter, user, v1, v2].map(snap))
                const gasUsed = receipt!.gasUsed
                const txFees = gasUsed * nextBaseFee
                expect(v2Before.balance).to.equal(v2After.balance + txFees, 'tx runner has his native token reduced to pay for gas')
                expect(v2Before.weth).to.equal(v2After.weth, 'tx runner does not have any weth modified')
                expect(v2Before.token2).to.equal(v2After.token2, 'tx runner does not have any token modified')
                // destination
                expect(userBefore.balance).to.be.equal(userAfter.balance, 'user did not have to run any transaction')
                expect(userBefore.weth).to.be.equal(userAfter.weth, 'users weth was not touched')
                expect(userBefore.token2).to.be.lessThan(userAfter.token2, 'user got tokens delivered to them')
                const userDelta = userAfter.token2 - userBefore.token2
                expect(userDelta).to.be.lessThan(oneEther, 'the amount they received was less than they put in because of fees')
                expect(userDelta).to.be.greaterThan(oneEther * 99n / 100n, 'vast majority is maintained (based on base fee)')
                // recipient of fees
                expect(v1Before.balance).to.be.equal(v1After.balance, 'fee recipients native tokens were not touched')
                expect(v1Before.weth).to.be.equal(v1After.weth, 'fee recipients weth was not touched')
                expect(v1Before.token2).to.be.lessThan(v1After.token2, 'fee recipient received fees in form of token')
                const actionFees = v1After.token2 - v1Before.token2
                expect(wethRouterBefore.balance).to.equal(wethRouterAfter.balance)
                expect(wethRouterBefore.weth).to.equal(wethRouterAfter.weth)
                expect(wethRouterBefore.token2).to.equal(wethRouterAfter.token2 + userDelta + actionFees)
            })
        })
    })
})
