import hre from 'hardhat'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import * as helpers from '../helpers/helpers'
import * as setup from '../setup'
import * as ethers from 'ethers'
import { AMBMock, ForeignOmnibridge, WETH, WETHOmnibridgeRouter__factory } from '../../artifacts/types'

const oneEther = ethers.parseEther('1')
const dailyLimit = ethers.parseEther('2.5')
const maxPerTx = oneEther
const minPerTx = ethers.parseEther('0.01')
const executionDailyLimit = dailyLimit
const executionMaxPerTx = maxPerTx
describe('WETHOmnibridgeRouter', () => {
    let token!: WETH
    let mediator!: ForeignOmnibridge
    let WETHOmnibridgeRouter!: WETHOmnibridgeRouter__factory
    let ambBridgeContract!: AMBMock
    let signers!: ethers.Signer[]
    let owner!: ethers.Signer
    let user!: ethers.Signer
    const deployContracts = async () => {
        signers = await hre.ethers.getSigners()
        owner = signers[0]
        user = signers[1]
        const PermittableToken = await setup.requirePrecompiled('PermittableToken')
        const ForeignOmnibridge = await hre.ethers.getContractFactory('ForeignOmnibridge')
        WETHOmnibridgeRouter = await hre.ethers.getContractFactory('WETHOmnibridgeRouter')
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
    }

    beforeEach(async () => {
        await loadFixture(deployContracts)
    })

    it('wrapAndRelayTokens', async () => {
        const value = oneEther
        const WETHRouter = await WETHOmnibridgeRouter.deploy(mediator, token, owner)
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
        const WETHRouter = await WETHOmnibridgeRouter.deploy(stubMediator, token, owner)
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
        const WETHRouter = await WETHOmnibridgeRouter.deploy(mediator, token, owner)
        const value = oneEther / 100n
        await token.deposit({ value: value })
        await expect(token.transfer(WETHRouter, value)).to.be.fulfilled
        await expect(WETHRouter.connect(user).claimTokens(token, user)).to.be.rejected
        await expect(WETHRouter.connect(owner).claimTokens(token, user)).to.be.fulfilled
        await expect(token.balanceOf(user))
            .eventually.to.be.equal(value.toString())
    })
})
