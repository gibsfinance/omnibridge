import hre from 'hardhat'
import mocha from 'mocha'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import * as ethers from 'ethers'
import type { AddressLike, BigNumberish, BytesLike } from 'ethers'
import * as utils from '../helpers/helpers'
import * as setup from '../setup'
import { getCompoundContracts } from '../compound/contracts'
import { getAAVEContracts } from '../aave/contracts'
import type { EternalStorageProxy__factory, Sacrifice__factory, SelectorTokenGasLimitManager__factory, TokenFactory__factory, TokenReceiver__factory, HomeOmnibridge__factory, ForeignOmnibridge__factory, MultiTokenForwardingRulesManager__factory } from '../../artifacts/types'
import type { OmnibridgeFeeManager__factory } from '../../artifacts/types/factories/contracts/upgradeable_contracts/modules/fee_manager'
import type { HomeOmnibridge, ForeignOmnibridge, BridgeValidators } from '../../artifacts/types/contracts/upgradeable_contracts'
import type { ERC677BridgeToken, PermittableToken, ERC677BridgeToken__factory, PermittableToken__factory } from '../../artifacts/types/contracts/precompiled'
import type { IStakedAave, IStakedTokenIncentivesController, ICToken, IHarnessComptroller, ILendingPool, IMintableERC20 } from '../../artifacts/types/contracts/interfaces'
import type { IERC20 } from '../../artifacts/types/@openzeppelin/contracts/token/ERC20'
import type { AAVEInterestERC20, CompoundInterestERC20 } from '../../artifacts/types/contracts/upgradeable_contracts/modules/interest'
import type { MultiTokenForwardingRulesManager } from '../../artifacts/types/contracts/upgradeable_contracts/modules/forwarding_rules'
import type { SelectorTokenGasLimitManager } from '../../artifacts/types/contracts/upgradeable_contracts/modules/gas_limit'
import type { TokenFactory } from '../../artifacts/types/contracts/upgradeable_contracts/modules/factory'
import type { OmnibridgeFeeManager } from '../../artifacts/types/contracts/upgradeable_contracts/modules/fee_manager'
import { HexString } from 'ethers/lib.commonjs/utils/data'
import { AAVEInterestERC20Mock__factory, AMBMock__factory, CompoundInterestERC20Mock__factory } from '../../artifacts/types/factories/contracts/mocks'
import { AMBMock, TokenReceiver } from '../../artifacts/types/contracts/mocks'
import { MockedEventEvent } from '../../artifacts/types/contracts/mocks/AMBMock'
import { FailedMessageFixedEvent, NewTokenRegisteredEvent, TokensBridgedEvent, TokensBridgingInitiatedEvent } from '../../artifacts/types/contracts/upgradeable_contracts/BasicOmnibridge'
import { FeeDistributedEvent } from '../../artifacts/types/contracts/upgradeable_contracts/HomeOmnibridge'
const halfEther = ethers.parseEther('0.5')
const oneEther = ethers.parseEther('1')
const twoEthers = ethers.parseEther('2')
const dailyLimit = ethers.parseEther('2.5')
const maxPerTx = oneEther
const minPerTx = ethers.parseEther('0.01')
const executionDailyLimit = dailyLimit
const executionMaxPerTx = maxPerTx
const exampleMessageId = '0xf308b922ab9f8a7128d9d7bc9bce22cd88b2c05c8213f0e2d8104d78e0a9ecbb'
const otherMessageId = '0x35d3818e50234655f6aebb2a1cfbf30f59568d8a4ec72066fac5a25dbe7b8121'
const otherMessageId2 = '0x9f5102f0a927f5ddd371db9938354105719c4a36d083acea27ab535c1c7849c6'
const failedMessageId = '0x2ebc2ccc755acc8eaf9252e19573af708d644ab63a39619adb080a3500a4ff2e'
const selectors = {
  deployAndHandleBridgedTokens: '0x2ae87cdd',
  deployAndHandleBridgedTokensAndCall: '0xd522cfd7',
  handleBridgedTokens: '0x125e4cfb',
  handleBridgedTokensAndCall: '0xc5345761',
  handleNativeTokens: '0x272255bb',
  handleNativeTokensAndCall: '0x867f7a4d',
  fixFailedMessage: '0x0950d515',
}
const logsFrom = async <T extends ethers.BaseContract>(c: T, tx: ethers.TransactionResponse) => {
  const receipt = await tx.wait() as ethers.TransactionReceipt
  return receipt.logs.map((l) => c.interface.parseLog(l))
    .filter((log): log is ethers.LogDescription => !!log)
}

interface TestFn {
  (this: Mocha.Test): Promise<void>;
}
type MediatorType = HomeOmnibridge | ForeignOmnibridge
function runTests(isHome: boolean) {
  const value = 10n ** 18n
  let signers!: ethers.Signer[]
  let HomeOmnibridge!: HomeOmnibridge__factory
  let ForeignOmnibridge!: ForeignOmnibridge__factory
  let EternalStorageProxy!: EternalStorageProxy__factory
  let AMBMock!: AMBMock__factory
  let Sacrifice!: Sacrifice__factory
  let TokenFactory!: TokenFactory__factory
  let MultiTokenForwardingRulesManager!: MultiTokenForwardingRulesManager__factory
  let OmnibridgeFeeManager!: OmnibridgeFeeManager__factory
  let SelectorTokenGasLimitManager!: SelectorTokenGasLimitManager__factory
  let TokenReceiver!: TokenReceiver__factory
  let CompoundInterestERC20!: CompoundInterestERC20Mock__factory
  let AAVEInterestERC20!: AAVEInterestERC20Mock__factory
  let Mediator!: ForeignOmnibridge__factory | HomeOmnibridge__factory
  let ERC677BridgeToken!: ERC677BridgeToken__factory
  let PermittableToken!: PermittableToken__factory
  let contract!: MediatorType
  let token!: ERC677BridgeToken
  let ambBridgeContract!: AMBMock
  let currentDay!: bigint
  let tokenImage!: PermittableToken
  let tokenFactory!: TokenFactory
  let tokenReceiver!: TokenReceiver
  let bridgeValidators!: BridgeValidators
  let owner!: ethers.Signer
  let user!: ethers.Signer
  let user2!: ethers.Signer
  const SUFFIX = ' on Testnet'
  const modifyName = (name: string) => name + SUFFIX
  const otherSideMediator = '0x1e33FBB006F47F78704c954555a5c52C2A7f409D'
  const otherSideToken1 = '0xAfb77d544aFc1e2aD3dEEAa20F3c80859E7Fc3C9'
  const otherSideToken2 = '0x876bD892b01D1c9696D873f74cbeF8fc9Bfb1142'
  const executeMessageCall = async (messageId: HexString, data: string, options: {
    executor?: string,
    messageSender?: string,
    gas?: number,
  } = {}) => {
    const opts = options || {}
    const msgId = hre.ethers.zeroPadValue(messageId, 32)
    const tx = await ambBridgeContract.executeMessageCall(
      opts.executor || await contract.getAddress(),
      opts.messageSender || otherSideMediator,
      data,
      msgId,
      opts.gas || 1000000,
    )
    await tx.wait()
    return ambBridgeContract.messageCallStatus(msgId)
  }
  const mineBlock = (timeSeconds: number | bigint) => (
    hre.ethers.provider.send('evm_mine', [`0x${timeSeconds.toString(16)}`])
  )
  const initialize = async (options: {
    ambContract?: ethers.AddressLike,
    otherSideMediator?: ethers.AddressLike,
    limits?: [number | bigint, number | bigint, number | bigint],
    executionLimits?: [number | bigint, number | bigint],
    gasLimitManager?: ethers.AddressLike,
    requestGasLimit?: bigint | number,
    owner?: ethers.AddressLike,
    tokenFactory?: ethers.AddressLike,
    feeManager?: ethers.AddressLike,
    forwardingRulesManager?: ethers.AddressLike,
  } = {}) => {
    const opts = options || {}
    const args = [
      opts.ambContract || await ambBridgeContract.getAddress(),
      opts.otherSideMediator || otherSideMediator,
      opts.limits || [dailyLimit, maxPerTx, minPerTx],
      opts.executionLimits || [executionDailyLimit, executionMaxPerTx],
    ] as const
    if (isHome) {
      const a = [
        ...args,
        opts.gasLimitManager || setup.ZERO_ADDRESS,
        opts.owner || await owner.getAddress(),
        opts.tokenFactory || await tokenFactory.getAddress(),
        opts.feeManager || setup.ZERO_ADDRESS,
        opts.forwardingRulesManager || setup.ZERO_ADDRESS,
      ] as const
      return (contract as HomeOmnibridge).initialize(...a)
    }
    else {
      const a = [
        ...args,
        opts.requestGasLimit || 1_000_000,
        opts.owner || await owner.getAddress(),
        opts.tokenFactory || await tokenFactory.getAddress(),
      ] as const
      return (contract as ForeignOmnibridge).initialize(...a)
    }
  }
  const sendFunctions = [
    async function emptyAlternativeReceiver(value = oneEther) {
      return token.connect(user).transferAndCall(contract, value, '0x')
        .then(() => user.getAddress())
    },
    async function sameAlternativeReceiver(value = oneEther) {
      return token.connect(user)
        .transferAndCall(contract, value, await user.getAddress())
        .then(() => user.getAddress())
    },
    async function differentAlternativeReceiver(value = oneEther) {
      return token.connect(user)
        .transferAndCall(contract, value, await user2.getAddress())
        .then(() => user2.getAddress())
    },
    async function simpleRelayTokens1(value = oneEther) {
      const c = contract.connect(user)
      await token.connect(user).approve(contract, value)
      return c.getFunction('relayTokens(address,uint256)')(token, value)
        .then(() => user.getAddress())
    },
    async function simpleRelayTokens2(value = oneEther) {
      const c = contract.connect(user)
      await token.connect(user).approve(contract, value)
      return c.getFunction('relayTokens(address,address,uint256)')(token, user, value)
        .then(() => user.getAddress())
    },
    async function relayTokensWithAlternativeReceiver(value = oneEther) {
      const c = contract.connect(user)
      await token.connect(user).approve(contract, value)
      return c.getFunction('relayTokens(address,address,uint256)')(token, user2, value)
        .then(() => user2.getAddress())
    },
    async function alternativeReceiverWithData(value = oneEther) {
      return token.connect(user)
        .transferAndCall(contract, value, `${await tokenReceiver.getAddress()}1122`)
        .then(() => tokenReceiver.getAddress())
    },
    async function relayTokensWithData(value = oneEther) {
      await token.connect(user).approve(contract, value)
      return contract.connect(user)
        .relayTokensAndCall(token, tokenReceiver, value, '0x1122')
        .then(async () => tokenReceiver.getAddress())
    },
  ]

  const deployContracts = async () => {
    signers = await hre.ethers.getSigners()
    HomeOmnibridge = await hre.ethers.getContractFactory('HomeOmnibridge')
    ForeignOmnibridge = await hre.ethers.getContractFactory('ForeignOmnibridge')
    EternalStorageProxy = await hre.ethers.getContractFactory('EternalStorageProxy')
    AMBMock = await hre.ethers.getContractFactory('AMBMock')
    Sacrifice = await hre.ethers.getContractFactory('Sacrifice')
    TokenFactory = await hre.ethers.getContractFactory('TokenFactory')
    MultiTokenForwardingRulesManager = await hre.ethers.getContractFactory('MultiTokenForwardingRulesManager')
    OmnibridgeFeeManager = await hre.ethers.getContractFactory('OmnibridgeFeeManager')
    SelectorTokenGasLimitManager = await hre.ethers.getContractFactory('SelectorTokenGasLimitManager')
    TokenReceiver = await hre.ethers.getContractFactory('TokenReceiver')
    CompoundInterestERC20 = await hre.ethers.getContractFactory('CompoundInterestERC20Mock')
    AAVEInterestERC20 = await hre.ethers.getContractFactory('AAVEInterestERC20Mock')
    Mediator = isHome ? HomeOmnibridge : ForeignOmnibridge
      ; ([
        owner, user, user2,
      ] = await hre.ethers.getSigners())
    ERC677BridgeToken = await setup.requirePrecompiled('ERC677BridgeToken')
    PermittableToken = await setup.requirePrecompiled('PermittableToken')
    const BridgeValidators = await hre.ethers.getContractFactory('BridgeValidators')
    bridgeValidators = await BridgeValidators.deploy()
    contract = await Mediator.deploy(SUFFIX)
    currentDay = await contract.getCurrentDay()
    ambBridgeContract = await AMBMock.deploy(bridgeValidators)
    tokenImage = await PermittableToken.deploy('TEST', 'TST', 18, 1337)
    tokenFactory = await TokenFactory.deploy(owner, tokenImage)
    token = await ERC677BridgeToken.deploy('TEST', 'TST', 18)
    tokenReceiver = await TokenReceiver.deploy()
  }
  beforeEach(async () => {
    await loadFixture(deployContracts)
  })
  describe('getBridgeMode', () => {
    it('should return mediator mode and interface', async () => {
      const bridgeModeHash = '0xb1516c26'; // 4 bytes of keccak256('multi-erc-to-erc-amb')
      await expect(contract.getBridgeMode())
        .eventually.to.equal(bridgeModeHash)
      const { major, minor, patch } = await contract.getBridgeInterfacesVersion()
      expect(major).to.be.greaterThanOrEqual(0n)
      expect(minor).to.be.greaterThanOrEqual(0n)
      expect(patch).to.be.greaterThanOrEqual(0n)
    })
  })
  describe('claimTokens', () => {
    const deployContractsClaimTokens = async () => {
      await deployContracts()
      const storageProxy = await EternalStorageProxy.deploy()
      await storageProxy.upgradeTo('1', contract)
      contract = Mediator.attach(await storageProxy.getAddress()) as ForeignOmnibridge | HomeOmnibridge
      await initialize()
    }

    beforeEach(async () => {
      await loadFixture(deployContractsClaimTokens)
    })

    it('should work for unknown token', async () => {
      await token.mint(user, oneEther)
      await expect(token.balanceOf(user))
        .eventually.to.equal(oneEther)
      await token.connect(user).transfer(contract, oneEther)
      await expect(token.balanceOf(user))
        .eventually.to.equal(0n)
      await expect(token.balanceOf(contract))
        .eventually.to.equal(oneEther)
      await expect(contract.connect(user).claimTokens(token, signers[3])).to.be.rejected
      await contract.connect(owner).claimTokens(token, signers[3])
      await expect(token.balanceOf(contract))
        .eventually.to.equal(0n)
      await expect(token.balanceOf(signers[3]))
        .eventually.to.equal(oneEther)
    })

    it('should work for native coins', async () => {
      await Sacrifice.deploy(contract, { value: oneEther }).catch(() => { })
      await expect(hre.ethers.provider.getBalance(contract)).eventually.to.equal(oneEther)
      const balanceBefore = BigInt(await hre.ethers.provider.getBalance(signers[3]))
      await expect(contract.connect(user).claimTokens(setup.ZERO_ADDRESS, signers[3])).to.be.rejected
      await contract.connect(owner).claimTokens(setup.ZERO_ADDRESS, signers[3])
      await expect(hre.ethers.provider.getBalance(contract)).eventually.to.equal(0n)
      await expect(hre.ethers.provider.getBalance(signers[3])).eventually.to.equal(balanceBefore + oneEther)
    })

    it('should not work for native bridged token', async () => {
      await token.mint(user, oneEther)
      await expect(token.balanceOf(user))
        .eventually.to.equal(oneEther)
      await token.connect(user).transferAndCall(contract, oneEther, '0x')
      await expect(token.balanceOf(user))
        .eventually.to.equal(0n)
      await expect(token.balanceOf(contract))
        .eventually.to.be.gt(0)
      await expect(contract.connect(user).claimTokens(token, signers[3])).to.be.rejected
      await expect(contract.connect(owner).claimTokens(token, signers[3])).to.be.rejected
    })

    it('should allow owner to claim tokens from token contract', async () => {
      const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
        AddressLike,
        string,
        string,
        BigNumberish,
        AddressLike,
        BigNumberish
      ]
      const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
      await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
      const bridgedToken = await contract.bridgedTokenAddress(otherSideToken1)
      await token.mint(user, 1)
      await token.connect(user).transfer(bridgedToken, 1)
      await expect(contract.connect(user).claimTokensFromTokenContract(bridgedToken, token, signers[3])).to.be.rejected
      await contract.connect(owner).claimTokensFromTokenContract(bridgedToken, token, signers[3])
      await expect(token.balanceOf(signers[3])).eventually.to.equal('1')
    })
  })
  describe('initialize', () => {
    const deployContractsInitialize = async () => {
      await deployContracts()
      const storageProxy = await EternalStorageProxy.deploy()
      await storageProxy.upgradeTo('1', contract)
      contract = Mediator.attach(await storageProxy.getAddress()) as ForeignOmnibridge | HomeOmnibridge
    }

    beforeEach(async () => {
      await loadFixture(deployContractsInitialize)
    })

    it('should initialize parameters', async () => {
      // Given
      await expect(contract.isInitialized()).eventually.to.equal(false)
      await expect(contract.bridgeContract()).eventually.to.equal(setup.ZERO_ADDRESS)
      await expect(contract.mediatorContractOnOtherSide()).eventually.to.equal(setup.ZERO_ADDRESS)
      await expect(contract.dailyLimit(setup.ZERO_ADDRESS)).eventually.to.equal(0n)
      await expect(contract.maxPerTx(setup.ZERO_ADDRESS)).eventually.to.equal(0n)
      await expect(contract.minPerTx(setup.ZERO_ADDRESS)).eventually.to.equal(0n)
      await expect(contract.executionDailyLimit(setup.ZERO_ADDRESS)).eventually.to.equal(0n)
      await expect(contract.executionMaxPerTx(setup.ZERO_ADDRESS)).eventually.to.equal(0n)
      if (isHome) {
        await expect((contract as HomeOmnibridge).gasLimitManager()).eventually.to.equal(setup.ZERO_ADDRESS)
      }
      else {
        await expect((contract as ForeignOmnibridge).requestGasLimit())
          .eventually.to.equal(0n)
      }
      await expect(contract.owner()).eventually.to.equal(setup.ZERO_ADDRESS)
      await expect(contract.tokenFactory()).eventually.to.equal(setup.ZERO_ADDRESS)
      // When
      // not valid bridge address
      await expect(initialize({ ambContract: setup.ZERO_ADDRESS })).to.be.rejected
      // dailyLimit > maxPerTx
      await expect(initialize({ limits: [maxPerTx, maxPerTx, minPerTx] })).to.be.rejected
      // maxPerTx > minPerTx
      await expect(initialize({ limits: [dailyLimit, minPerTx, minPerTx] })).to.be.rejected
      // executionDailyLimit > executionMaxPerTx
      await expect(initialize({ executionLimits: [executionDailyLimit, executionDailyLimit] })).to.be.rejected
      if (isHome) {
        // gas limit manage is not a contract
        await expect(initialize({ gasLimitManager: await owner.getAddress() })).to.be.rejected
        // fee manager is not a contract
        await expect(initialize({ feeManager: await owner.getAddress() })).to.be.rejected
        // forwarding rules manager is not a contract
        await expect(initialize({ forwardingRulesManager: await owner.getAddress() })).to.be.rejected
      }
      else {
        // maxGasPerTx > bridge maxGasPerTx
        await expect(initialize({ requestGasLimit: ethers.parseEther('1') })).to.be.rejected
      }
      // not valid owner
      await expect(initialize({ owner: setup.ZERO_ADDRESS })).to.be.rejected
      // token factory is not a contract
      await expect(initialize({ tokenFactory: await owner.getAddress() })).to.be.rejected
      const tx = await initialize()
      const logs = await logsFrom(contract, tx)
      // already initialized
      await expect(initialize()).to.be.rejected
      // Then
      await expect(contract.isInitialized()).eventually.to.equal(true)
      await expect(contract.bridgeContract()).eventually.to.equal(await ambBridgeContract.getAddress())
      await expect(contract.mediatorContractOnOtherSide()).eventually.to.equal(otherSideMediator)
      await expect(contract.dailyLimit(setup.ZERO_ADDRESS)).eventually.to.equal(dailyLimit)
      await expect(contract.maxPerTx(setup.ZERO_ADDRESS)).eventually.to.equal(maxPerTx)
      await expect(contract.minPerTx(setup.ZERO_ADDRESS)).eventually.to.equal(minPerTx)
      await expect(contract.executionDailyLimit(setup.ZERO_ADDRESS)).eventually.to.equal(executionDailyLimit)
      await expect(contract.executionMaxPerTx(setup.ZERO_ADDRESS)).eventually.to.equal(executionMaxPerTx)
      if (isHome) {
        await expect((contract as HomeOmnibridge).gasLimitManager()).eventually.to.equal(setup.ZERO_ADDRESS)
      }
      else {
        await expect((contract as ForeignOmnibridge).requestGasLimit()).eventually.to.equal('1000000')
      }
      await expect(contract.owner()).eventually.to.equal(owner)
      await expect(contract.tokenFactory()).eventually.to.equal(await tokenFactory.getAddress())
      utils.expectEventInLogs(logs, 'ExecutionDailyLimitChanged', { token: setup.ZERO_ADDRESS, newLimit: executionDailyLimit })
      utils.expectEventInLogs(logs, 'DailyLimitChanged', { token: setup.ZERO_ADDRESS, newLimit: dailyLimit })
    })
  })
  describe('afterInitialization', () => {
    const deployContractsAfterInitialization = async () => {
      await deployContracts()
      await token.connect(owner).mint(user, ethers.parseEther('10'))
      await initialize()
      const initialEvents = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
      expect(initialEvents.length).to.equal(0)
    }

    beforeEach(async () => {
      await loadFixture(deployContractsAfterInitialization)
    })

    describe('update mediator parameters', () => {
      describe('limits', () => {
        it('should allow to update default daily limits', async () => {
          await expect(contract.connect(user).setDailyLimit(setup.ZERO_ADDRESS, ethers.parseEther('5'))).to.be.rejected
          await expect(contract.connect(user).setExecutionDailyLimit(setup.ZERO_ADDRESS, ethers.parseEther('5'))).to.be.rejected
          await expect(contract.connect(owner).setDailyLimit(setup.ZERO_ADDRESS, ethers.parseEther('0.5'))).to.be.rejected
          await expect(contract.connect(owner).setExecutionDailyLimit(setup.ZERO_ADDRESS, ethers.parseEther('0.5'))).to.be.rejected
          await contract.connect(owner).setDailyLimit(setup.ZERO_ADDRESS, ethers.parseEther('5'))
          await contract.connect(owner).setExecutionDailyLimit(setup.ZERO_ADDRESS, ethers.parseEther('5'))
          await expect(contract.dailyLimit(setup.ZERO_ADDRESS)).eventually.to.equal(ethers.parseEther('5'))
          await expect(contract.executionDailyLimit(setup.ZERO_ADDRESS)).eventually.to.equal(ethers.parseEther('5'))
          await contract.connect(owner).setDailyLimit(setup.ZERO_ADDRESS, 0n)
          await contract.connect(owner).setExecutionDailyLimit(setup.ZERO_ADDRESS, 0n)
          await expect(contract.dailyLimit(setup.ZERO_ADDRESS)).eventually.to.equal(0n)
          await expect(contract.executionDailyLimit(setup.ZERO_ADDRESS)).eventually.to.equal(0n)
        })

        it('should allow to update default max per tx limits', async () => {
          await expect(contract.connect(user).setMaxPerTx(setup.ZERO_ADDRESS, ethers.parseEther('1.5'))).to.be.rejected
          await expect(contract.connect(user).setExecutionMaxPerTx(setup.ZERO_ADDRESS, ethers.parseEther('1.5'))).to.be.rejected
          await expect(contract.connect(owner).setMaxPerTx(setup.ZERO_ADDRESS, ethers.parseEther('5'))).to.be.rejected
          await expect(contract.connect(owner).setExecutionMaxPerTx(setup.ZERO_ADDRESS, ethers.parseEther('5'))).to.be.rejected
          await expect(contract.connect(owner).setMaxPerTx(setup.ZERO_ADDRESS, ethers.parseEther('0.001'))).to.be.rejected
          await contract.connect(owner).setMaxPerTx(setup.ZERO_ADDRESS, ethers.parseEther('1.5'))
          await contract.connect(owner).setExecutionMaxPerTx(setup.ZERO_ADDRESS, ethers.parseEther('1.5'))
          await expect(contract.maxPerTx(setup.ZERO_ADDRESS)).eventually.to.equal(ethers.parseEther('1.5'))
          await expect(contract.executionMaxPerTx(setup.ZERO_ADDRESS)).eventually.to.equal(ethers.parseEther('1.5'))
          await contract.connect(owner).setMaxPerTx(setup.ZERO_ADDRESS, 0n)
          await contract.connect(owner).setExecutionMaxPerTx(setup.ZERO_ADDRESS, 0n)
          await expect(contract.maxPerTx(setup.ZERO_ADDRESS)).eventually.to.equal(0n)
          await expect(contract.executionMaxPerTx(setup.ZERO_ADDRESS)).eventually.to.equal(0n)
        })

        it('should allow to update default min per tx limit', async () => {
          await expect(contract.connect(user).setMinPerTx(setup.ZERO_ADDRESS, ethers.parseEther('0.1'))).to.be.rejected
          await expect(contract.connect(owner).setMinPerTx(setup.ZERO_ADDRESS, 0n)).to.be.rejected
          await contract.connect(owner).setMinPerTx(setup.ZERO_ADDRESS, ethers.parseEther('0.1'))
          await expect(contract.minPerTx(setup.ZERO_ADDRESS)).eventually.to.equal(ethers.parseEther('0.1'))
          await expect(contract.connect(owner).setMinPerTx(setup.ZERO_ADDRESS, 0n)).to.be.rejected
        })

        it('should only allow to update parameters for known tokens', async () => {
          await expect(contract.connect(owner).setDailyLimit(token, ethers.parseEther('5'))).to.be.rejected
          await expect(contract.connect(owner).setMaxPerTx(token, ethers.parseEther('1.5'))).to.be.rejected
          await expect(contract.connect(owner).setMinPerTx(token, ethers.parseEther('0.02'))).to.be.rejected
          await expect(contract.connect(owner).setExecutionDailyLimit(token, ethers.parseEther('5'))).to.be.rejected
          await expect(contract.connect(owner).setExecutionMaxPerTx(token, ethers.parseEther('1.5'))).to.be.rejected
          await token.connect(user).transferAndCall(contract, value, '0x')
          await contract.connect(owner).setDailyLimit(token, ethers.parseEther('5'))
          await contract.connect(owner).setMaxPerTx(token, ethers.parseEther('1.5'))
          await contract.connect(owner).setMinPerTx(token, ethers.parseEther('0.02'))
          await contract.connect(owner).setExecutionDailyLimit(token, ethers.parseEther('6'))
          await contract.connect(owner).setExecutionMaxPerTx(token, ethers.parseEther('1.6'))
          await expect(contract.dailyLimit(token)).eventually.to.equal(ethers.parseEther('5'))
          await expect(contract.maxPerTx(token)).eventually.to.equal(ethers.parseEther('1.5'))
          await expect(contract.minPerTx(token)).eventually.to.equal(ethers.parseEther('0.02'))
          await expect(contract.executionDailyLimit(token)).eventually.to.equal(ethers.parseEther('6'))
          await expect(contract.executionMaxPerTx(token)).eventually.to.equal(ethers.parseEther('1.6'))
          const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          const bridgedToken = await contract.bridgedTokenAddress(otherSideToken1)
          await contract.connect(owner).setDailyLimit(bridgedToken, ethers.parseEther('5'))
          await contract.connect(owner).setMaxPerTx(bridgedToken, ethers.parseEther('1.5'))
          await contract.connect(owner).setMinPerTx(bridgedToken, ethers.parseEther('0.02'))
          await contract.connect(owner).setExecutionDailyLimit(bridgedToken, ethers.parseEther('6'))
          await contract.connect(owner).setExecutionMaxPerTx(bridgedToken, ethers.parseEther('1.6'))
          await expect(contract.dailyLimit(bridgedToken)).eventually.to.equal(ethers.parseEther('5'))
          await expect(contract.maxPerTx(bridgedToken)).eventually.to.equal(ethers.parseEther('1.5'))
          await expect(contract.minPerTx(bridgedToken)).eventually.to.equal(ethers.parseEther('0.02'))
          await expect(contract.executionDailyLimit(bridgedToken)).eventually.to.equal(ethers.parseEther('6'))
          await expect(contract.executionMaxPerTx(bridgedToken)).eventually.to.equal(ethers.parseEther('1.6'))
        })
      })

      describe('token factory', () => {
        it('should allow to change token image', async () => {
          const newTokenImage = await PermittableToken.deploy('Test', 'TST', 18, 1337)
          await expect(tokenFactory.connect(owner).setTokenImage(owner)).to.be.rejected
          await expect(tokenFactory.connect(user).setTokenImage(await newTokenImage.getAddress())).to.be.rejected
          await tokenFactory.connect(owner).setTokenImage(await newTokenImage.getAddress())
          await expect(tokenFactory.tokenImage()).eventually.to.equal(await newTokenImage.getAddress())
        })

        it('should allow to change token factory', async () => {
          const newTokenFactory = await TokenFactory.deploy(owner, tokenImage)
          await expect(contract.connect(owner).setTokenFactory(owner)).to.be.rejected
          await expect(contract.connect(user).setTokenFactory(await newTokenFactory.getAddress())).to.be.rejected
          await contract.connect(owner).setTokenFactory(await newTokenFactory.getAddress())
          await expect(contract.tokenFactory()).eventually.to.equal(await newTokenFactory.getAddress())
        })
      })
      let homeOmnibridge!: HomeOmnibridge
      if (isHome) {
        describe('gas limit manager', () => {
          let manager!: SelectorTokenGasLimitManager

          beforeEach(async () => {
            manager = await SelectorTokenGasLimitManager.deploy(ambBridgeContract, owner, 1000000)
            homeOmnibridge = contract as HomeOmnibridge
          })

          it('should allow to set new manager', async () => {
            await expect(homeOmnibridge.gasLimitManager()).eventually.to.equal(setup.ZERO_ADDRESS)
            await expect(homeOmnibridge.connect(user).setGasLimitManager(manager.getAddress())).to.be.rejected
            await homeOmnibridge.connect(owner).setGasLimitManager(manager.getAddress())
            await expect(homeOmnibridge.gasLimitManager()).eventually.to.equal(await manager.getAddress())
            await expect(manager.owner()).eventually.to.equal(owner)
            await expect(manager.bridge()).eventually.to.equal(await ambBridgeContract.getAddress())
            await expect(manager.getFunction('requestGasLimit()')()).eventually.to.equal('1000000')
          })

          it('should allow to set request gas limit for specific selector', async () => {
            await homeOmnibridge.connect(owner).setGasLimitManager(await manager.getAddress())
            await expect(manager.connect(user).getFunction('setRequestGasLimit(bytes4,uint256)')('0xffffffff', 200000)).to.be.rejected
            await manager.connect(owner).getFunction('setRequestGasLimit(bytes4,uint256)')('0xffffffff', 200000)
            await expect(manager.getFunction('requestGasLimit(bytes4)')('0xffffffff')).eventually.to.equal('200000')
            await expect(manager.getFunction('requestGasLimit()')()).eventually.to.equal('1000000')
          })

          it('should use the custom gas limit when bridging tokens', async () => {
            await homeOmnibridge.setGasLimitManager(manager)
            await sendFunctions[0](ethers.parseEther('0.01'))
            const reverseData = homeOmnibridge.interface.encodeFunctionData('handleNativeTokens', [
              await token.getAddress(), await user.getAddress(), ethers.parseEther('0.01')
            ])
            await expect(executeMessageCall(otherMessageId, reverseData)).eventually.to.equal(true)
            await sendFunctions[0](ethers.parseEther('0.01'))
            const method = manager.getFunction('setRequestGasLimit(bytes4,uint256)')
            await method(selectors.handleBridgedTokens, 200000)
            await sendFunctions[0](ethers.parseEther('0.01'))
            const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
            expect(events.length).to.equal(3)
            expect(events[0].args.gas).to.equal('1000000')
            expect(events[1].args.gas).to.equal('1000000')
            expect(events[2].args.gas).to.equal('200000')
          })

          it('should allow to set request gas limit for specific selector and token', async () => {
            await homeOmnibridge.setGasLimitManager(await manager.getAddress())
            await expect(manager.connect(user).getFunction('setRequestGasLimit(bytes4,address,uint256)')('0xffffffff', token, 200000)).to.be.rejected
            await manager.connect(owner).getFunction('setRequestGasLimit(bytes4,address,uint256)')('0xffffffff', token, 200000)
            await expect(manager.getFunction('requestGasLimit(bytes4,address)')('0xffffffff', token)).eventually.to.equal('200000')
            await expect(manager.getFunction('requestGasLimit(bytes4)')('0xffffffff')).eventually.to.equal('0')
            await expect(manager.getFunction('requestGasLimit()')()).eventually.to.equal('1000000')
          })

          it('should use the custom gas limit when bridging specific token', async () => {
            await homeOmnibridge.setGasLimitManager(manager)
            const method1 = manager.getFunction('setRequestGasLimit(bytes4,uint256)')
            await method1(selectors.handleBridgedTokens, 100000)
            await sendFunctions[0](ethers.parseEther('0.01'))
            const reverseData = contract.interface.encodeFunctionData('handleNativeTokens', [
              await token.getAddress(), await user.getAddress(), ethers.parseEther('0.01'),
            ])
            await expect(executeMessageCall(otherMessageId, reverseData)).eventually.to.equal(true)
            await sendFunctions[0](ethers.parseEther('0.01'))
            const method2 = manager.getFunction('setRequestGasLimit(bytes4,address,uint256)')
            await method2(selectors.handleBridgedTokens, token, 200000)
            await sendFunctions[0](ethers.parseEther('0.01'))
            const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
            expect(events.length).to.equal(3)
            expect(events[0].args.gas).to.equal('1000000')
            expect(events[1].args.gas).to.equal('100000')
            expect(events[2].args.gas).to.equal('200000')
          })

          describe('common gas limits setters', () => {
            const token = otherSideToken1

            it('should use setCommonRequestGasLimits', async () => {
              await expect(manager.connect(user).setCommonRequestGasLimits([100, 200, 50, 100, 50, 100, 99])).to.be.rejected
              await expect(manager.connect(owner).setCommonRequestGasLimits([200, 100, 50, 100, 50, 100, 99])).to.be.rejected
              await expect(manager.connect(owner).setCommonRequestGasLimits([100, 200, 100, 50, 50, 100, 99])).to.be.rejected
              await expect(manager.connect(owner).setCommonRequestGasLimits([100, 200, 50, 100, 100, 50, 99])).to.be.rejected
              await expect(manager.connect(owner).setCommonRequestGasLimits([10, 20, 50, 100, 50, 100, 99])).to.be.rejected
              await manager.connect(owner).setCommonRequestGasLimits([100, 200, 50, 100, 50, 100, 99])
              const method = manager.getFunction('requestGasLimit(bytes4)')
              await expect(method(selectors.deployAndHandleBridgedTokens)).eventually.to.equal('100')
              await expect(method(selectors.deployAndHandleBridgedTokensAndCall)).eventually.to.equal('200')
              await expect(method(selectors.handleBridgedTokens)).eventually.to.equal('50')
              await expect(method(selectors.handleBridgedTokensAndCall)).eventually.to.equal('100')
              await expect(method(selectors.handleNativeTokens)).eventually.to.equal('50')
              await expect(method(selectors.handleNativeTokensAndCall)).eventually.to.equal('100')
              await expect(method(selectors.fixFailedMessage)).eventually.to.equal('99')
            })

            it('should use setBridgedTokenRequestGasLimits', async () => {
              await expect(manager.connect(user).setBridgedTokenRequestGasLimits(token, [100, 200])).to.be.rejected
              await expect(manager.connect(owner).setBridgedTokenRequestGasLimits(token, [200, 100])).to.be.rejected
              await manager.connect(owner).setBridgedTokenRequestGasLimits(token, [100, 200])
              const method = manager.getFunction('requestGasLimit(bytes4,address)')
              await expect(method(selectors.handleNativeTokens, token)).eventually.to.equal('100')
              await expect(method(selectors.handleNativeTokensAndCall, token)).eventually.to.equal('200')
            })

            it('should use setNativeTokenRequestGasLimits', async () => {
              await expect(manager.connect(user).setNativeTokenRequestGasLimits(token, [100, 200, 50, 100])).to.be.rejected
              await expect(manager.connect(owner).setNativeTokenRequestGasLimits(token, [200, 100, 50, 100])).to.be.rejected
              await expect(manager.connect(owner).setNativeTokenRequestGasLimits(token, [100, 200, 100, 50])).to.be.rejected
              await expect(manager.connect(owner).setNativeTokenRequestGasLimits(token, [10, 20, 50, 100])).to.be.rejected
              await manager.connect(owner).setNativeTokenRequestGasLimits(token, [100, 200, 50, 100])
              const method = manager.getFunction('requestGasLimit(bytes4,address)')
              await expect(method(selectors.deployAndHandleBridgedTokens, token)).eventually.to.equal('100')
              await expect(method(selectors.deployAndHandleBridgedTokensAndCall, token)).eventually.to.equal('200')
              await expect(method(selectors.handleBridgedTokens, token)).eventually.to.equal('50')
              await expect(method(selectors.handleBridgedTokensAndCall, token)).eventually.to.equal('100')
            })
          })
        })
      }
      else {
        describe('request gas limit', () => {
          it('should allow to set default gas limit', async () => {
            const foreignOmnibridge = contract as ForeignOmnibridge
            await expect(foreignOmnibridge.connect(user).setRequestGasLimit(200000)).to.be.rejected
            await foreignOmnibridge.connect(owner).setRequestGasLimit(200000)
            await expect(foreignOmnibridge.requestGasLimit()).eventually.to.equal('200000')
          })

          it('should use the custom gas limit when bridging tokens', async () => {
            const foreignOmnibridge = contract as ForeignOmnibridge
            await sendFunctions[0](ethers.parseEther('0.01'))
            await sendFunctions[0](ethers.parseEther('0.01'))
            await foreignOmnibridge.setRequestGasLimit(200000)
            await sendFunctions[0](ethers.parseEther('0.01'))
            const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
            expect(events.length).to.equal(3)
            expect(events[0].args.gas).to.equal('1000000')
            expect(events[1].args.gas).to.equal('1000000')
            expect(events[2].args.gas).to.equal('200000')
          })
        })
      }
    })
    function commonRelayTests() {
      it('should respect global shutdown', async () => {
        await contract.setDailyLimit(setup.ZERO_ADDRESS, 0n)
        for (const send of sendFunctions) {
          await expect(send()).to.be.rejected
        }
        await contract.setDailyLimit(setup.ZERO_ADDRESS, dailyLimit)
        for (const send of sendFunctions) {
          await send(minPerTx)
        }
      })
      it('should respect limits', async () => {
        for (const send of sendFunctions) {
          await expect(send(ethers.parseEther('0.001'))).to.be.rejected
          await expect(send(ethers.parseEther('1.001'))).to.be.rejected
        }
        const simpleSend = sendFunctions[0]
        await simpleSend()
        await simpleSend()
        await expect(contract.maxAvailablePerTx(token)).eventually.to.equal(halfEther)
        for (const send of sendFunctions) {
          await expect(send(ethers.parseEther('1.001'))).to.be.rejected
          await expect(send(ethers.parseEther('0.8'))).to.be.rejected
          await send(minPerTx)
        }
      })
    }

    describe('native tokens', () => {
      describe('initialization', () => {
        for (const decimals of [3, 18, 20]) {
          it(`should initialize limits according to decimals = ${decimals}`, async () => {
            const f1 = BigInt(`1${'0'.repeat(decimals)}`)
            const f2 = BigInt('1000000000000000000')
            token = await ERC677BridgeToken.deploy('TEST', 'TST', decimals)
            await token.mint(user, (value * f1) / f2)
            await expect(token.connect(user).transferAndCall(contract, (value * f1) / f2, '0x')).to.be
              .fulfilled
            await expect(contract.dailyLimit(token)).eventually.to.equal((dailyLimit * f1) / f2)
            await expect(contract.maxPerTx(token)).eventually.to.equal((maxPerTx * f1) / f2)
            await expect(contract.minPerTx(token)).eventually.to.equal((minPerTx * f1) / f2)
            await expect(contract.executionDailyLimit(token)).eventually.to.equal((executionDailyLimit * f1) / f2)
            await expect(contract.executionMaxPerTx(token)).eventually.to.equal((executionMaxPerTx * f1) / f2)
          })
        }

        it('should initialize limits according to decimals = 0', async () => {
          token = await ERC677BridgeToken.deploy('TEST', 'TST', 0)
          await token.mint(user, '1')
          await token.connect(user).transferAndCall(contract, '1', '0x')
          await expect(contract.dailyLimit(token)).eventually.to.equal('10000')
          await expect(contract.maxPerTx(token)).eventually.to.equal('100')
          await expect(contract.minPerTx(token)).eventually.to.equal('1')
          await expect(contract.executionDailyLimit(token)).eventually.to.equal('10000')
          await expect(contract.executionMaxPerTx(token)).eventually.to.equal('100')
        })
      })

      describe('tokens relay', () => {
        for (const send of sendFunctions) {
          it(`should make calls to deployAndHandleBridgedTokens and handleBridgedTokens using ${send.name}`, async () => {
            const receiver = await send()
            await expect(contract.maxAvailablePerTx(token)).eventually.to.equal(value)
            await expect(contract.isRegisteredAsNativeToken(token)).eventually.to.equal(true)
            await send(halfEther)
            const reverseData = contract.interface.encodeFunctionData('handleNativeTokens', [
              await token.getAddress(),
              await user.getAddress(),
              halfEther,
            ])
            await expect(contract.isBridgedTokenDeployAcknowledged(token)).eventually.to.equal(false)
            await expect(executeMessageCall(otherMessageId, reverseData)).eventually.to.equal(true)
            await expect(contract.isBridgedTokenDeployAcknowledged(token)).eventually.to.equal(true)
            await send(halfEther)
            const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
            expect(events.length).to.equal(3)
            for (let i = 0; i < 2; i++) {
              const { data, dataType, executor } = events[i].args
              expect(executor).to.equal(otherSideMediator)
              let args
              if (receiver === await tokenReceiver.getAddress()) {
                expect(data.slice(0, 10)).to.equal(selectors.deployAndHandleBridgedTokensAndCall)
                args = hre.ethers.AbiCoder.defaultAbiCoder().decode(['address', 'string', 'string', 'uint8', 'address', 'uint256', 'bytes'], `0x${data.slice(10)}`)
                expect(args[6]).to.equal('0x1122')
              }
              else {
                expect(data.slice(0, 10)).to.equal(selectors.deployAndHandleBridgedTokens)
                args = hre.ethers.AbiCoder.defaultAbiCoder().decode(['address', 'string', 'string', 'uint8', 'address', 'uint256'], `0x${data.slice(10)}`)
              }
              await expect(token.getAddress()).eventually.to.equal(args[0])
              await expect(token.name()).eventually.to.equal(args[1])
              await expect(token.symbol()).eventually.to.equal(args[2])
              await expect(token.decimals()).eventually.to.equal(args[3])
              expect(args[4]).to.equal(receiver)
              expect(args[5]).to.equal((i === 0 ? value : halfEther).toString())
              expect(dataType).to.equal('0')
            }
            const { data, dataType } = events[2].args
            let args
            if (receiver === await tokenReceiver.getAddress()) {
              expect(data.slice(0, 10)).to.equal(selectors.handleBridgedTokensAndCall)
              args = hre.ethers.AbiCoder.defaultAbiCoder().decode(['address', 'address', 'uint256', 'bytes'], `0x${data.slice(10)}`)
              expect(args[3]).to.equal('0x1122')
            }
            else {
              expect(data.slice(0, 10)).to.equal(selectors.handleBridgedTokens)
              args = hre.ethers.AbiCoder.defaultAbiCoder().decode(['address', 'address', 'uint256'], `0x${data.slice(10)}`)
            }
            await expect(token.getAddress()).eventually.to.equal(args[0])
            expect(args[1]).to.equal(receiver)
            expect(args[2]).to.equal(halfEther.toString())
            expect(dataType).to.equal('0')
            await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(twoEthers)
            await expect(contract.mediatorBalance(token)).eventually.to.equal(ethers.parseEther('1.5'))
            await expect(contract.isTokenRegistered(token)).eventually.to.equal(true)
            await expect(token.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1.5'))
            await expect(contract.maxAvailablePerTx(token)).eventually.to.equal(halfEther)
            const depositEvents = await utils.getEvents<TokensBridgingInitiatedEvent.Event>(contract, 'TokensBridgingInitiated')
            expect(depositEvents.length).to.equal(3)
            await expect(token.getAddress()).eventually.to.equal(depositEvents[0].args.token)
            expect(depositEvents[0].args.sender).to.equal(user)
            expect(depositEvents[0].args.value).to.equal(value.toString())
            expect(depositEvents[0].args.messageId).to.include('0x11223344')
            await expect(token.getAddress()).eventually.to.equal(depositEvents[1].args.token)
            expect(depositEvents[1].args.sender).to.equal(user)
            expect(depositEvents[1].args.value).to.equal(halfEther.toString())
            expect(depositEvents[1].args.messageId).to.include('0x11223344')
            await expect(token.getAddress()).eventually.to.equal(depositEvents[2].args.token)
            expect(depositEvents[2].args.sender).to.equal(user)
            expect(depositEvents[2].args.value).to.equal(halfEther.toString())
            expect(depositEvents[2].args.messageId).to.include('0x11223344')
          })
        }

        it('should allow to use relayTokensAndCall', async () => {
          await sendFunctions[0]()
          const reverseData = contract.interface.encodeFunctionData('handleNativeTokens', [
            await token.getAddress(),
            await user.getAddress(),
            halfEther,
          ])
          await expect(executeMessageCall(otherMessageId, reverseData)).eventually.to.equal(true)
          let events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
          expect(events.length).to.equal(1)
          await token.connect(user).approve(contract, value)
          await contract.connect(user).relayTokensAndCall(token, otherSideToken1, value, '0x1122')
          events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
          expect(events.length).to.equal(2)
          const { data, dataType } = events[1].args
          expect(data.slice(0, 10)).to.equal(selectors.handleBridgedTokensAndCall)
          const args = hre.ethers.AbiCoder.defaultAbiCoder().decode(['address', 'address', 'uint256', 'bytes'], `0x${data.slice(10)}`)
          expect(args[0]).to.equal(await token.getAddress())
          expect(args[1]).to.equal(otherSideToken1)
          expect(args[2]).to.equal(value.toString())
          expect(args[3]).to.equal('0x1122')
          expect(dataType).to.equal('0')
          await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(twoEthers)
          await expect(contract.mediatorBalance(token)).eventually.to.equal(ethers.parseEther('1.5'))
          await expect(contract.isTokenRegistered(token)).eventually.to.equal(true)
          await expect(token.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1.5'))
          await expect(contract.maxAvailablePerTx(token)).eventually.to.equal(halfEther)
          const depositEvents = await utils.getEvents<TokensBridgingInitiatedEvent.Event>(contract, 'TokensBridgingInitiated')
          expect(depositEvents.length).to.equal(2)
          expect(depositEvents[1].args.token).to.equal(await token.getAddress())
          expect(depositEvents[1].args.sender).to.equal(user)
          expect(depositEvents[1].args.value).to.equal(value.toString())
          expect(depositEvents[1].args.messageId).to.include('0x11223344')
        })
        commonRelayTests()

        describe('fixFailedMessage', () => {
          for (const send of sendFunctions) {
            it(`should fix tokens locked via ${send.name}`, async () => {
              // User transfer tokens twice
              await send(halfEther)
              await send(value)
              const reverseData = contract.interface.encodeFunctionData('handleNativeTokens', [
                await token.getAddress(),
                await user.getAddress(),
                value,
              ])
              await expect(executeMessageCall(otherMessageId2, reverseData)).eventually.to.equal(true)
              await send(halfEther)
              await expect(contract.mediatorBalance(token)).eventually.to.equal(oneEther)
              await expect(token.balanceOf(user)).eventually.to.equal(ethers.parseEther('9'))
              const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
              expect(events.length).to.equal(3)
              const transferMessageId1 = events[0].args.messageId
              const transferMessageId2 = events[2].args.messageId
              await expect(contract.messageFixed(transferMessageId1)).eventually.to.equal(false)
              await expect(contract.messageFixed(transferMessageId2)).eventually.to.equal(false)
              await expect(contract.connect(user).fixFailedMessage(transferMessageId2)).to.be.rejected
              await expect(contract.connect(owner).fixFailedMessage(transferMessageId2)).to.be.rejected
              const fixData1 = contract.interface.encodeFunctionData('fixFailedMessage', [transferMessageId1])
              const fixData2 = contract.interface.encodeFunctionData('fixFailedMessage', [transferMessageId2])
              // Should be called by mediator from other side so it will fail
              await expect(executeMessageCall(failedMessageId, fixData2, { messageSender: await owner.getAddress() })).eventually.to.equal(false)
              await expect(ambBridgeContract.messageCallStatus(failedMessageId)).eventually.to.equal(false)
              await expect(contract.messageFixed(transferMessageId2)).eventually.to.equal(false)
              await expect(executeMessageCall(exampleMessageId, fixData2)).eventually.to.equal(true)
              await expect(token.balanceOf(user)).eventually.to.equal(ethers.parseEther('9.5'))
              await expect(contract.mediatorBalance(token)).eventually.to.equal(halfEther)
              await expect(contract.messageFixed(transferMessageId1)).eventually.to.equal(false)
              await expect(contract.messageFixed(transferMessageId2)).eventually.to.equal(true)
              await expect(contract.minPerTx(token)).eventually.to.be.gt(0)
              await expect(executeMessageCall(otherMessageId, fixData1)).eventually.to.equal(true)
              await expect(token.balanceOf(user)).eventually.to.equal(ethers.parseEther('10'))
              await expect(contract.mediatorBalance(token)).eventually.to.equal(0n)
              await expect(contract.messageFixed(transferMessageId1)).eventually.to.equal(true)
              const event = await utils.getEvents<FailedMessageFixedEvent.Event>(contract, 'FailedMessageFixed')
              expect(event.length).to.equal(2)
              expect(event[0].args.messageId).to.equal(transferMessageId2)
              expect(event[0].args.token).to.equal(await token.getAddress())
              expect(event[0].args.recipient).to.equal(user)
              expect(event[0].args.value).to.equal(halfEther.toString())
              expect(event[1].args.messageId).to.equal(transferMessageId1)
              expect(event[1].args.token).to.equal(await token.getAddress())
              expect(event[1].args.recipient).to.equal(user)
              expect(event[1].args.value).to.equal(halfEther.toString())
              await expect(executeMessageCall(failedMessageId, fixData1)).eventually.to.equal(false)
              await expect(executeMessageCall(failedMessageId, fixData2)).eventually.to.equal(false)
            })
          }
        })

        describe('fixMediatorBalance', () => {
          const deployContractsFixMediatorBalance = async () => {
            await deployContracts()
            const storageProxy = await EternalStorageProxy.deploy()
            await storageProxy.upgradeTo('1', contract)
            contract = Mediator.attach(await storageProxy.getAddress()) as MediatorType
            await token.connect(owner).mint(user, twoEthers)
            await token.connect(owner).mint(contract, twoEthers)
            await initialize()
            await token.connect(user).transferAndCall(contract, oneEther, '0x')
            await expect(contract.mediatorBalance(token)).eventually.to.equal(oneEther)
            await expect(token.balanceOf(contract)).eventually.to.equal(ethers.parseEther('3'))
            await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(oneEther)
            const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
            expect(events.length).to.equal(1)
          }

          beforeEach(async () => {
            await loadFixture(deployContractsFixMediatorBalance)
          })

          it('should allow to fix extra mediator balance', async () => {
            await contract.setDailyLimit(token, ethers.parseEther('5'))
            await contract.setMaxPerTx(token, ethers.parseEther('2'))
            await expect(contract.connect(user).fixMediatorBalance(token, owner)).to.be.rejected
            await expect(contract.connect(owner).fixMediatorBalance(setup.ZERO_ADDRESS, owner)).to.be.rejected
            await expect(contract.connect(owner).fixMediatorBalance(token, setup.ZERO_ADDRESS)).to.be.rejected
            await contract.connect(owner).fixMediatorBalance(token, owner)
            await expect(contract.connect(owner).fixMediatorBalance(token, owner)).to.be.rejected
            await expect(contract.mediatorBalance(token)).eventually.to.equal(ethers.parseEther('3'))
            await expect(token.balanceOf(contract)).eventually.to.equal(ethers.parseEther('3'))
            await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(ethers.parseEther('3'))
            const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
            expect(events.length).to.equal(2)
            const { data, dataType, executor } = events[1].args
            expect(data.slice(0, 10)).to.equal(selectors.deployAndHandleBridgedTokens)
            expect(executor).to.equal(otherSideMediator)
            expect(dataType).to.equal('0')
          })

          it('should use different methods on the other side', async () => {
            await contract.connect(owner).fixMediatorBalance(token, owner)
            const reverseData = contract.interface.encodeFunctionData('handleNativeTokens', [
              await token.getAddress(),
              await user.getAddress(),
              halfEther,
            ])
            await expect(executeMessageCall(otherMessageId, reverseData)).eventually.to.equal(true)
            await contract.connect(owner).fixMediatorBalance(token, owner)
            const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
            expect(events.length).to.equal(3)
            expect(events[1].args.data.slice(0, 10)).to.equal(selectors.deployAndHandleBridgedTokens)
            expect(events[2].args.data.slice(0, 10)).to.equal(selectors.handleBridgedTokens)
          })

          it('should allow to fix extra mediator balance with respect to limits', async () => {
            await expect(contract.connect(user).fixMediatorBalance(token, owner)).to.be.rejected
            await expect(contract.connect(owner).fixMediatorBalance(setup.ZERO_ADDRESS, owner)).to.be.rejected
            await expect(contract.connect(owner).fixMediatorBalance(token, setup.ZERO_ADDRESS)).to.be.rejected
            await contract.connect(owner).fixMediatorBalance(token, owner)
            await expect(contract.mediatorBalance(token)).eventually.to.equal(ethers.parseEther('2'))
            await expect(token.balanceOf(contract)).eventually.to.equal(ethers.parseEther('3'))
            await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(ethers.parseEther('2'))
            await contract.connect(owner).fixMediatorBalance(token, owner)
            await expect(contract.mediatorBalance(token)).eventually.to.equal(ethers.parseEther('2.5'))
            await expect(token.balanceOf(contract)).eventually.to.equal(ethers.parseEther('3'))
            await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(ethers.parseEther('2.5'))
            const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
            expect(events.length).to.equal(3)
            await expect(contract.connect(owner).fixMediatorBalance(token, owner)).to.be.rejected
            await contract.setDailyLimit(token, ethers.parseEther('1.5'))
            await expect(contract.connect(owner).fixMediatorBalance(token, owner)).to.be.rejected
          })
        })
      })

      describe('handleNativeTokens', () => {
        it('should unlock tokens on message from amb', async () => {
          await token.connect(user).transferAndCall(contract, value, '0x')
          await token.connect(user).transferAndCall(contract, value, '0x')
          await expect(token.balanceOf(contract)).eventually.to.equal(twoEthers)
          await expect(contract.mediatorBalance(token)).eventually.to.equal(twoEthers)
          // can't be called by user
          await expect(contract.connect(user).handleNativeTokens(token, user, value)).to.be.rejected
          // can't be called by owner
          await expect(contract.connect(owner).handleNativeTokens(token, user, value)).to.be.rejected
          const data = contract.interface.encodeFunctionData('handleNativeTokens', [
            await token.getAddress(),
            await user.getAddress(),
            value.toString(),
          ])
          // message must be generated by mediator contract on the other network
          await expect(executeMessageCall(failedMessageId, data, { messageSender: await owner.getAddress() })).eventually.to.equal(false)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          await expect(contract.totalExecutedPerDay(token, currentDay)).eventually.to.equal(value)
          await expect(contract.mediatorBalance(token)).eventually.to.equal(value)
          await expect(token.balanceOf(user)).eventually.to.equal(ethers.parseEther('9'))
          await expect(token.balanceOf(contract)).eventually.to.equal(value)
          await expect(contract.isBridgedTokenDeployAcknowledged(token)).eventually.to.equal(true)
          const event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
          expect(event.length).to.equal(1)
          await expect(token.getAddress()).eventually.to.equal(event[0].args.token)
          expect(event[0].args.recipient).to.equal(user)
          expect(event[0].args.value).to.equal(value.toString())
          expect(event[0].args.messageId).to.equal(exampleMessageId)
        })

        it('should not allow to use unregistered tokens', async () => {
          const otherToken = await ERC677BridgeToken.deploy('Test', 'TST', 18)
          await otherToken.mint(await contract.getAddress(), value)
          const data = contract.interface.encodeFunctionData('handleNativeTokens', [
            await otherToken.getAddress(),
            await user.getAddress(),
            value.toString(),
          ])
          await expect(executeMessageCall(failedMessageId, data)).eventually.to.equal(false)
        })

        it('should not allow to operate when global shutdown is enabled', async () => {
          await token.connect(user).transferAndCall(contract, value, '0x')
          await token.connect(user).transferAndCall(contract, value, '0x')
          const data = contract.interface.encodeFunctionData('handleNativeTokens', [
            await token.getAddress(),
            await user.getAddress(),
            value.toString(),
          ])
          await contract.setExecutionDailyLimit(setup.ZERO_ADDRESS, 0n)
          await expect(executeMessageCall(failedMessageId, data)).eventually.to.equal(false)
          await contract.setExecutionDailyLimit(setup.ZERO_ADDRESS, executionDailyLimit)
          await expect(executeMessageCall(otherMessageId, data)).eventually.to.equal(true)
        })
      })

      describe('handleNativeTokensAndCall', () => {
        it('should unlock tokens on message from amb', async () => {
          await token.connect(user).transferAndCall(contract, value, '0x')
          await token.connect(user).transferAndCall(contract, value, '0x')
          await expect(token.balanceOf(contract)).eventually.to.equal(twoEthers)
          await expect(contract.mediatorBalance(token)).eventually.to.equal(twoEthers)
          const args = [await token.getAddress(), await tokenReceiver.getAddress(), value, '0x5566'] as [AddressLike, AddressLike, BigNumberish, BytesLike]
          // can't be called by user
          await expect(contract.connect(user).handleNativeTokensAndCall(...args)).to.be.rejected
          // can't be called by owner
          await expect(contract.connect(owner).handleNativeTokensAndCall(...args)).to.be.rejected
          const data = contract.interface.encodeFunctionData('handleNativeTokensAndCall', args)
          // message must be generated by mediator contract on the other network
          await expect(executeMessageCall(failedMessageId, data, { messageSender: await owner.getAddress() })).eventually.to.equal(false)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          await expect(contract.totalExecutedPerDay(token, currentDay)).eventually.to.equal(value)
          await expect(contract.mediatorBalance(token)).eventually.to.equal(value)
          await expect(token.balanceOf(tokenReceiver)).eventually.to.equal(ethers.parseEther('1'))
          await expect(token.balanceOf(contract)).eventually.to.equal(value)
          const event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
          expect(event.length).to.equal(1)
          expect(event[0].args.token).to.equal(token)
          expect(event[0].args.recipient).to.equal(tokenReceiver)
          expect(event[0].args.value).to.equal(value.toString())
          expect(event[0].args.messageId).to.equal(exampleMessageId)
          await expect(tokenReceiver.data()).eventually.to.equal('0x5566')
        })

        it('should not allow to use unregistered tokens', async () => {
          const otherToken = await ERC677BridgeToken.deploy('Test', 'TST', 18)
          await otherToken.mint(contract, value)
          const data = contract.interface.encodeFunctionData('handleNativeTokens', [
            await otherToken.getAddress(),
            await user.getAddress(),
            value.toString(),
          ])
          await expect(executeMessageCall(failedMessageId, data)).eventually.to.equal(false)
        })

        it('should not allow to operate when global shutdown is enabled', async () => {
          await token.connect(user).transferAndCall(contract, value, '0x')
          await token.connect(user).transferAndCall(contract, value, '0x')
          const data = contract.interface.encodeFunctionData('handleNativeTokens', [
            await token.getAddress(),
            await user.getAddress(),
            value.toString(),
          ])
          await contract.setExecutionDailyLimit(setup.ZERO_ADDRESS, 0n)
          await expect(executeMessageCall(failedMessageId, data)).eventually.to.equal(false)
          await contract.setExecutionDailyLimit(setup.ZERO_ADDRESS, executionDailyLimit)
          await expect(executeMessageCall(otherMessageId, data)).eventually.to.equal(true)
        })
      })

      describe('requestFailedMessageFix', () => {
        let msgData!: string

        beforeEach(async () => {
          await loadFixture(deployContractsAfterInitialization)
          msgData = contract.interface.encodeFunctionData('handleNativeTokens', [
            await token.getAddress(),
            await user.getAddress(),
            value.toString(),
          ])
        })

        it('should allow to request a failed message fix', async () => {
          await expect(executeMessageCall(failedMessageId, msgData)).eventually.to.equal(false)
          await contract.requestFailedMessageFix(failedMessageId)
          const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
          expect(events.length).to.equal(1)
          const { data } = events[0].args
          expect(data.slice(0, 10)).to.equal(selectors.fixFailedMessage)
          const args = hre.ethers.AbiCoder.defaultAbiCoder().decode(['bytes32'], `0x${data.slice(10)}`)
          expect(args[0]).to.equal(failedMessageId)
        })

        it('should be a failed transaction', async () => {
          await token.connect(user).transferAndCall(contract, value, '0x')
          await expect(executeMessageCall(exampleMessageId, msgData)).eventually.to.equal(true)
          await expect(contract.requestFailedMessageFix(exampleMessageId)).to.be.rejected
        })

        it('should be the receiver of the failed transaction', async () => {
          await expect(executeMessageCall(failedMessageId, msgData, { executor: await ambBridgeContract.getAddress() })).eventually.to.equal(false)
          await expect(contract.requestFailedMessageFix(failedMessageId)).to.be.rejected
        })

        it('message sender should be mediator from other side', async () => {
          await expect(executeMessageCall(failedMessageId, msgData, { messageSender: await owner.getAddress() })).eventually.to.equal(false)
          await expect(contract.requestFailedMessageFix(failedMessageId)).to.be.rejected
        })

        it('should allow to request a fix multiple times', async () => {
          await expect(executeMessageCall(failedMessageId, msgData)).eventually.to.equal(false)
          await contract.requestFailedMessageFix(failedMessageId)
          await contract.requestFailedMessageFix(failedMessageId)
          const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
          expect(events.length).to.equal(2)
          expect(events[0].args.data.slice(0, 10)).to.equal(selectors.fixFailedMessage)
          expect(events[1].args.data.slice(0, 10)).to.equal(selectors.fixFailedMessage)
        })
      })
    })

    describe('bridged tokens', () => {
      describe('tokens relay', () => {
        beforeEach(async () => {
          await loadFixture(deployContractsAfterInitialization)
          await contract.setExecutionDailyLimit(setup.ZERO_ADDRESS, ethers.parseEther('10'))
          await contract.setExecutionMaxPerTx(setup.ZERO_ADDRESS, ethers.parseEther('5'))
          const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), ethers.parseEther('5')] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const deployData = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          await expect(executeMessageCall(exampleMessageId, deployData)).eventually.to.equal(true)
          token = PermittableToken.attach(await contract.bridgedTokenAddress(otherSideToken1)) as PermittableToken
        })
        for (const send of sendFunctions) {
          it(`should make calls to handleNativeTokens for bridged token using ${send.name}`, async () => {
            const receiver = await send()
            let events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
            expect(events.length).to.equal(1)
            const { data, dataType, executor } = events[0].args
            let args
            if (receiver === await tokenReceiver.getAddress()) {
              expect(data.slice(0, 10)).to.equal(selectors.handleNativeTokensAndCall)
              args = hre.ethers.AbiCoder.defaultAbiCoder().decode(['address', 'address', 'uint256', 'bytes'], `0x${data.slice(10)}`)
              expect(args[3]).to.equal('0x1122')
            }
            else {
              expect(data.slice(0, 10)).to.equal(selectors.handleNativeTokens)
              args = hre.ethers.AbiCoder.defaultAbiCoder().decode(['address', 'address', 'uint256'], `0x${data.slice(10)}`)
            }
            expect(executor).to.equal(otherSideMediator)
            expect(args[0]).to.equal(otherSideToken1)
            expect(args[1]).to.equal(receiver)
            expect(args[2]).to.equal(value.toString())
            await expect(contract.maxAvailablePerTx(token)).eventually.to.equal(value)
            await send()
            events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
            expect(events.length).to.equal(2)
            const { data: data2, dataType: dataType2 } = events[1].args
            let args2
            if (receiver === await tokenReceiver.getAddress()) {
              expect(data2.slice(0, 10)).to.equal(selectors.handleNativeTokensAndCall)
              args2 = hre.ethers.AbiCoder.defaultAbiCoder().decode(['address', 'address', 'uint256', 'bytes'], `0x${data2.slice(10)}`)
              expect(args2[3]).to.equal('0x1122')
            }
            else {
              expect(data2.slice(0, 10)).to.equal(selectors.handleNativeTokens)
              args2 = hre.ethers.AbiCoder.defaultAbiCoder().decode(['address', 'address', 'uint256'], `0x${data2.slice(10)}`)
            }
            expect(args2[0]).to.equal(otherSideToken1)
            expect(args2[1]).to.equal(receiver)
            expect(args2[2]).to.equal(value.toString())
            expect(dataType).to.equal('0')
            expect(dataType2).to.equal('0')
            await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(twoEthers)
            await expect(contract.mediatorBalance(token)).eventually.to.equal(0n)
            await expect(contract.isTokenRegistered(token)).eventually.to.equal(true)
            await expect(token.balanceOf(contract)).eventually.to.equal(0n)
            await expect(contract.maxAvailablePerTx(token)).eventually.to.equal(halfEther)
            const depositEvents = await utils.getEvents<TokensBridgingInitiatedEvent.Event>(contract, 'TokensBridgingInitiated')
            expect(depositEvents.length).to.equal(2)
            expect(depositEvents[0].args.token).to.equal(token)
            expect(depositEvents[0].args.sender).to.equal(user)
            expect(depositEvents[0].args.value).to.equal(value.toString())
            expect(depositEvents[0].args.messageId).to.include('0x11223344')
            expect(depositEvents[1].args.token).to.equal(token)
            expect(depositEvents[1].args.sender).to.equal(user)
            expect(depositEvents[1].args.value).to.equal(value.toString())
            expect(depositEvents[1].args.messageId).to.include('0x11223344')
          })
        }
        commonRelayTests()

        describe('fixFailedMessage', () => {
          for (const send of sendFunctions) {
            it(`should fix tokens locked via ${send.name}`, async () => {
              // User transfer tokens
              await send()
              await expect(token.balanceOf(user)).eventually.to.equal(ethers.parseEther('4'))
              const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
              expect(events.length).to.equal(1)
              const transferMessageId = events[0].args.messageId
              await expect(contract.messageFixed(transferMessageId)).eventually.to.equal(false)
              await expect(contract.connect(user).fixFailedMessage(transferMessageId)).to.be.rejected
              await expect(contract.connect(owner).fixFailedMessage(transferMessageId)).to.be.rejected
              const fixData = contract.interface.encodeFunctionData('fixFailedMessage', [transferMessageId])
              // Should be called by mediator from other side so it will fail
              await expect(executeMessageCall(failedMessageId, fixData, { messageSender: await owner.getAddress() })).eventually.to.equal(false)
              await expect(ambBridgeContract.messageCallStatus(failedMessageId)).eventually.to.equal(false)
              await expect(contract.messageFixed(transferMessageId)).eventually.to.equal(false)
              await expect(executeMessageCall(exampleMessageId, fixData)).eventually.to.equal(true)
              await expect(token.balanceOf(user)).eventually.to.equal(ethers.parseEther('5'))
              await expect(contract.messageFixed(transferMessageId)).eventually.to.equal(true)
              await expect(contract.minPerTx(token)).eventually.to.be.gt(0)
              const event = await utils.getEvents<FailedMessageFixedEvent.Event>(contract, 'FailedMessageFixed')
              expect(event.length).to.equal(1)
              expect(event[0].args.messageId).to.equal(transferMessageId)
              await expect(token.getAddress()).eventually.to.equal(event[0].args.token)
              expect(event[0].args.recipient).to.equal(user)
              expect(event[0].args.value).to.equal(value.toString())
              await expect(executeMessageCall(failedMessageId, fixData)).eventually.to.equal(false)
            })
          }
        })
      })

      describe('deployAndHandleBridgedTokens', () => {
        it('should deploy contract and mint tokens on first message from amb', async () => {
          // can't be called by user
          const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          await expect(contract.connect(user).deployAndHandleBridgedTokens(...args)).to.be.rejected
          // can't be called by owner
          await expect(contract.connect(owner).deployAndHandleBridgedTokens(...args)).to.be.rejected
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          // message must be generated by mediator contract on the other network
          await expect(executeMessageCall(failedMessageId, data, { messageSender: await owner.getAddress() })).eventually.to.equal(false)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          const events = await utils.getEvents<NewTokenRegisteredEvent.Event>(contract, 'NewTokenRegistered')
          expect(events.length).to.equal(1)
          const { nativeToken, bridgedToken } = events[0].args
          expect(nativeToken).to.equal(otherSideToken1)
          const deployedToken = PermittableToken.attach(bridgedToken) as PermittableToken
          await expect(deployedToken.name()).eventually.to.equal(modifyName('Test'))
          await expect(deployedToken.symbol()).eventually.to.equal('TST')
          await expect(deployedToken.decimals()).eventually.to.equal('18')
          await expect(contract.nativeTokenAddress(bridgedToken)).eventually.to.equal(nativeToken)
          await expect(contract.bridgedTokenAddress(nativeToken)).eventually.to.equal(bridgedToken)
          if (isHome) {
            const homeOmnibrige = contract as HomeOmnibridge
            await expect(homeOmnibrige.foreignTokenAddress(bridgedToken)).eventually.to.equal(nativeToken)
            await expect(homeOmnibrige.homeTokenAddress(nativeToken)).eventually.to.equal(bridgedToken)
          }
          await expect(contract.isRegisteredAsNativeToken(bridgedToken)).eventually.to.equal(false)
          await expect(contract.totalExecutedPerDay(deployedToken, currentDay)).eventually.to.equal(value)
          await expect(contract.mediatorBalance(deployedToken)).eventually.to.equal(0n)
          await expect(deployedToken.balanceOf(user)).eventually.to.equal(value)
          await expect(deployedToken.balanceOf(contract)).eventually.to.equal(0n)
          const event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
          expect(event.length).to.equal(1)
          expect(event[0].args.token).to.equal(await deployedToken.getAddress())
          expect(event[0].args.recipient).to.equal(user)
          expect(event[0].args.value).to.equal(value.toString())
          expect(event[0].args.messageId).to.equal(exampleMessageId)
        })

        it('should do not deploy new contract if token is already deployed', async () => {
          const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          await expect(executeMessageCall(otherSideToken1, data)).eventually.to.equal(true)
          const events = await utils.getEvents<NewTokenRegisteredEvent.Event>(contract, 'NewTokenRegistered')
          expect(events.length).to.equal(1)
          const event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
          expect(event.length).to.equal(2)
        })

        it('should modify use symbol instead of name if empty', async () => {
          const args = [otherSideToken1, '', 'TST', 18, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          const deployedToken = PermittableToken.attach(await contract.bridgedTokenAddress(otherSideToken1)) as PermittableToken
          await expect(deployedToken.name()).eventually.to.equal(modifyName('TST'))
          await expect(deployedToken.symbol()).eventually.to.equal('TST')
          await expect(deployedToken.decimals()).eventually.to.equal('18')
        })

        it('should modify use name instead of symbol if empty', async () => {
          const args = [otherSideToken1, 'Test', '', 18, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          8778
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          const deployedToken = PermittableToken.attach(await contract.bridgedTokenAddress(otherSideToken1)) as PermittableToken
          await expect(deployedToken.name()).eventually.to.equal(modifyName('Test'))
          await expect(deployedToken.symbol()).eventually.to.equal('Test')
          await expect(deployedToken.decimals()).eventually.to.equal('18')
        })
        for (const decimals of [3, 18, 20]) {
          it(`should deploy token with different decimals = ${decimals}`, async () => {
            const f1 = BigInt(`1${'0'.repeat(decimals)}`)
            const f2 = BigInt('1000000000000000000')
            const args = [otherSideToken1, 'Test', 'TST', decimals, await user.getAddress(), value * f1 / f2] as [
              AddressLike,
              string,
              string,
              BigNumberish,
              AddressLike,
              BigNumberish
            ]
            const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
            await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
            const deployedTokenAddr = await contract.bridgedTokenAddress(otherSideToken1)
            const deployedToken = PermittableToken.attach(deployedTokenAddr) as PermittableToken
            await expect(deployedToken.decimals()).eventually.to.equal(decimals.toString())
            await expect(contract.dailyLimit(deployedTokenAddr)).eventually.to.equal((dailyLimit * f1) / f2)
            await expect(contract.maxPerTx(deployedTokenAddr)).eventually.to.equal((maxPerTx * f1) / f2)
            await expect(contract.minPerTx(deployedTokenAddr)).eventually.to.equal((minPerTx * f1) / f2)
            await expect(contract.executionDailyLimit(deployedTokenAddr)).eventually.to.equal((executionDailyLimit * f1) / f2)
            await expect(contract.executionMaxPerTx(deployedTokenAddr)).eventually.to.equal((executionMaxPerTx * f1) / f2)
          })
        }

        it('should deploy token with different decimals = 0', async () => {
          const args = [otherSideToken1, 'Test', 'TST', 0, await user.getAddress(), 1] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          const deployedTokenAddr = await contract.bridgedTokenAddress(otherSideToken1)
          const deployedToken = PermittableToken.attach(deployedTokenAddr) as PermittableToken
          await expect(deployedToken.decimals()).eventually.to.equal('0')
          await expect(contract.dailyLimit(deployedTokenAddr)).eventually.to.equal('10000')
          await expect(contract.maxPerTx(deployedTokenAddr)).eventually.to.equal('100')
          await expect(contract.minPerTx(deployedTokenAddr)).eventually.to.equal('1')
          await expect(contract.executionDailyLimit(deployedTokenAddr)).eventually.to.equal('10000')
          await expect(contract.executionMaxPerTx(deployedTokenAddr)).eventually.to.equal('100')
        })

        it('should not allow to operate when global shutdown is enabled', async () => {
          const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          await contract.setExecutionDailyLimit(setup.ZERO_ADDRESS, 0n)
          await expect(executeMessageCall(failedMessageId, data)).eventually.to.equal(false)
          await contract.setExecutionDailyLimit(setup.ZERO_ADDRESS, executionDailyLimit)
          await expect(executeMessageCall(otherMessageId, data)).eventually.to.equal(true)
        })
      })

      describe('deployAndHandleBridgedTokensAndCall', () => {
        it('should deploy contract and mint tokens on first message from amb', async () => {
          // can't be called by user
          const args = [otherSideToken1, 'Test', 'TST', 18, await tokenReceiver.getAddress(), value, '0x5566'] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish,
            BytesLike
          ]
          await expect(contract.connect(user).deployAndHandleBridgedTokensAndCall(...args)).to.be.rejected
          // can't be called by owner
          await expect(contract.connect(owner).deployAndHandleBridgedTokensAndCall(...args)).to.be.rejected
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokensAndCall', args)
          // message must be generated by mediator contract on the other network
          await expect(executeMessageCall(failedMessageId, data, { messageSender: await owner.getAddress() })).eventually.to.equal(false)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          const events = await utils.getEvents<NewTokenRegisteredEvent.Event>(contract, 'NewTokenRegistered')
          expect(events.length).to.equal(1)
          const { nativeToken, bridgedToken } = events[0].args
          expect(nativeToken).to.equal(otherSideToken1)
          const deployedToken = PermittableToken.attach(bridgedToken) as PermittableToken
          await expect(deployedToken.name()).eventually.to.equal(modifyName('Test'))
          await expect(deployedToken.symbol()).eventually.to.equal('TST')
          await expect(deployedToken.decimals()).eventually.to.equal('18')
          await expect(contract.nativeTokenAddress(bridgedToken)).eventually.to.equal(nativeToken)
          await expect(contract.bridgedTokenAddress(nativeToken)).eventually.to.equal(bridgedToken)
          if (isHome) {
            const homeOmnibridge = contract as HomeOmnibridge
            await expect(homeOmnibridge.foreignTokenAddress(bridgedToken)).eventually.to.equal(nativeToken)
            await expect(homeOmnibridge.homeTokenAddress(nativeToken)).eventually.to.equal(bridgedToken)
          }
          await expect(contract.totalExecutedPerDay(deployedToken, currentDay)).eventually.to.equal(value)
          await expect(contract.mediatorBalance(deployedToken)).eventually.to.equal(0n)
          await expect(deployedToken.balanceOf(tokenReceiver)).eventually.to.equal(value)
          await expect(deployedToken.balanceOf(contract)).eventually.to.equal(0n)
          const event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
          expect(event.length).to.equal(1)
          await expect(deployedToken.getAddress()).eventually.to.equal(event[0].args.token)
          await expect(tokenReceiver.getAddress()).eventually.to.equal(event[0].args.recipient)
          expect(event[0].args.value).to.equal(value.toString())
          expect(event[0].args.messageId).to.equal(exampleMessageId)
          await expect(tokenReceiver.data()).eventually.to.equal('0x5566')
        })
      })

      describe('handleBridgedTokens', () => {
        let deployedToken!: PermittableToken

        beforeEach(async () => {
          const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish,
          ]
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          const events = await utils.getEvents<NewTokenRegisteredEvent.Event>(contract, 'NewTokenRegistered')
          expect(events.length).to.equal(1)
          const { nativeToken, bridgedToken } = events[0].args
          expect(nativeToken).to.equal(otherSideToken1)
          deployedToken = PermittableToken.attach(bridgedToken) as PermittableToken
          await expect(contract.totalExecutedPerDay(deployedToken, currentDay)).eventually.to.equal(value)
          await expect(deployedToken.balanceOf(user)).eventually.to.equal(value)
          await expect(deployedToken.balanceOf(contract)).eventually.to.equal(0n)
        })

        it('should mint existing tokens on repeated messages from amb', async () => {
          // can't be called by user
          await expect(contract.connect(user).handleBridgedTokens(otherSideToken1, user, value)).to.be.rejected
          // can't be called by owner
          await expect(contract.connect(owner).handleBridgedTokens(otherSideToken1, user, value)).to.be.rejected
          const data = contract.interface.encodeFunctionData('handleBridgedTokens', [otherSideToken1, await user.getAddress(), value])
          // message must be generated by mediator contract on the other network
          await expect(executeMessageCall(failedMessageId, data, { messageSender: await owner.getAddress() })).eventually.to.equal(false)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          await expect(contract.totalExecutedPerDay(deployedToken, currentDay)).eventually.to.equal(twoEthers)
          await expect(contract.mediatorBalance(deployedToken)).eventually.to.equal(0n)
          await expect(deployedToken.balanceOf(user)).eventually.to.equal(twoEthers)
          await expect(deployedToken.balanceOf(contract)).eventually.to.equal(0n)
          const event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
          expect(event.length).to.equal(2)
          expect(event[1].args.token).to.equal(await deployedToken.getAddress())
          expect(event[1].args.recipient).to.equal(user)
          expect(event[1].args.value).to.equal(value.toString())
          expect(event[1].args.messageId).to.equal(exampleMessageId)
        })

        it('should not allow to process unknown tokens', async () => {
          const data = contract.interface.encodeFunctionData('handleBridgedTokens', [otherSideToken2, await user.getAddress(), value])
          await expect(executeMessageCall(failedMessageId, data)).eventually.to.equal(false)
        })

        it('should not allow to operate when global shutdown is enabled', async () => {
          const data = contract.interface.encodeFunctionData('handleBridgedTokens', [otherSideToken1, await user.getAddress(), value])
          await contract.setExecutionDailyLimit(setup.ZERO_ADDRESS, 0n)
          await expect(executeMessageCall(failedMessageId, data)).eventually.to.equal(false)
          await contract.setExecutionDailyLimit(setup.ZERO_ADDRESS, executionDailyLimit)
          await expect(executeMessageCall(otherMessageId, data)).eventually.to.equal(true)
        })
      })

      describe('handleBridgedTokensAndCall', () => {
        let deployedToken!: PermittableToken

        beforeEach(async () => {
          const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          const events = await utils.getEvents<NewTokenRegisteredEvent.Event>(contract, 'NewTokenRegistered')
          expect(events.length).to.equal(1)
          const { nativeToken, bridgedToken } = events[0].args
          expect(nativeToken).to.equal(otherSideToken1)
          deployedToken = PermittableToken.attach(bridgedToken) as PermittableToken
          await expect(contract.totalExecutedPerDay(deployedToken, currentDay)).eventually.to.equal(value)
          await expect(deployedToken.balanceOf(user)).eventually.to.equal(value)
          await expect(deployedToken.balanceOf(contract)).eventually.to.equal(0n)
        })

        it('should mint existing tokens and call onTokenTransfer', async () => {
          const args = [otherSideToken1, await tokenReceiver.getAddress(), value, '0x1122'] as [AddressLike, AddressLike, BigNumberish, BytesLike]
          // can't be called by user
          await expect(contract.connect(user).handleBridgedTokensAndCall(...args)).to.be.rejected
          // can't be called by owner
          await expect(contract.connect(owner).handleBridgedTokensAndCall(...args)).to.be.rejected
          const data = contract.interface.encodeFunctionData('handleBridgedTokensAndCall', args)
          // message must be generated by mediator contract on the other network
          await expect(executeMessageCall(failedMessageId, data, { messageSender: await owner.getAddress() })).eventually.to.equal(false)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          await expect(contract.totalExecutedPerDay(deployedToken, currentDay)).eventually.to.equal(twoEthers)
          await expect(contract.mediatorBalance(deployedToken)).eventually.to.equal(0n)
          await expect(deployedToken.balanceOf(tokenReceiver)).eventually.to.equal(oneEther)
          await expect(deployedToken.balanceOf(contract)).eventually.to.equal(0n)
          await expect(tokenReceiver.token()).eventually.to.equal(await deployedToken.getAddress())
          await expect(tokenReceiver.from()).eventually.to.equal(await contract.getAddress())
          await expect(tokenReceiver.value()).eventually.to.equal(value)
          await expect(tokenReceiver.data()).eventually.to.equal('0x1122')
          const event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
          expect(event.length).to.equal(2)
          await expect(deployedToken.getAddress()).eventually.to.equal(event[1].args.token)
          await expect(tokenReceiver.getAddress()).eventually.to.equal(event[1].args.recipient)
          expect(event[1].args.value).to.equal(value.toString())
          expect(event[1].args.messageId).to.equal(exampleMessageId)
        })

        it('should mint existing tokens and handle missing onTokenTransfer', async () => {
          const args = [otherSideToken1, await user.getAddress(), value, '0x1122'] as [AddressLike, AddressLike, BigNumberish, BytesLike]
          // can't be called by user
          await expect(contract.connect(user).handleBridgedTokensAndCall(...args)).to.be.rejected
          // can't be called by owner
          await expect(contract.connect(owner).handleBridgedTokensAndCall(...args)).to.be.rejected
          const data = contract.interface.encodeFunctionData('handleBridgedTokensAndCall', args)
          // message must be generated by mediator contract on the other network
          await expect(executeMessageCall(failedMessageId, data, { messageSender: await owner.getAddress() })).eventually.to.equal(false)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          await expect(contract.totalExecutedPerDay(deployedToken, currentDay)).eventually.to.equal(twoEthers)
          await expect(contract.mediatorBalance(deployedToken)).eventually.to.equal(0n)
          await expect(deployedToken.balanceOf(user)).eventually.to.equal(twoEthers)
          await expect(deployedToken.balanceOf(contract)).eventually.to.equal(0n)
          const event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
          expect(event.length).to.equal(2)
          await expect(deployedToken.getAddress()).eventually.to.equal(event[1].args.token)
          expect(event[1].args.recipient).to.equal(user)
          expect(event[1].args.value).to.equal(value.toString())
          expect(event[1].args.messageId).to.equal(exampleMessageId)
        })

        it('should not allow to process unknown tokens', async () => {
          const data = contract.interface.encodeFunctionData('handleBridgedTokensAndCall', [
            otherSideToken2,
            await user.getAddress(),
            value,
            '0x00',
          ])
          await expect(executeMessageCall(failedMessageId, data)).eventually.to.equal(false)
        })

        it('should not allow to operate when global shutdown is enabled', async () => {
          const data = contract.interface.encodeFunctionData('handleBridgedTokensAndCall', [
            otherSideToken1,
            await user.getAddress(),
            value,
            '0x00',
          ])
          await contract.setExecutionDailyLimit(setup.ZERO_ADDRESS, 0n)
          await expect(executeMessageCall(failedMessageId, data)).eventually.to.equal(false)
          await contract.setExecutionDailyLimit(setup.ZERO_ADDRESS, executionDailyLimit)
          await expect(executeMessageCall(otherMessageId, data)).eventually.to.equal(true)
        })
      })

      describe('requestFailedMessageFix', () => {
        let msgData!: string

        beforeEach(async () => {
          msgData = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', [
            otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value.toString()
          ])
        })

        it('should allow to request a failed message fix', async () => {
          await expect(executeMessageCall(failedMessageId, msgData, { gas: 100 })).eventually.to.equal(false)
          await contract.requestFailedMessageFix(failedMessageId)
          const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
          expect(events.length).to.equal(1)
          const { data } = events[0].args
          expect(data.slice(0, 10)).to.equal(selectors.fixFailedMessage)
          const args = hre.ethers.AbiCoder.defaultAbiCoder().decode(['bytes32'], `0x${data.slice(10)}`)
          expect(args[0]).to.equal(failedMessageId)
        })

        it('should be a failed transaction', async () => {
          await expect(executeMessageCall(exampleMessageId, msgData)).eventually.to.equal(true)
          await expect(contract.requestFailedMessageFix(exampleMessageId)).to.be.rejected
        })

        it('should be the receiver of the failed transaction', async () => {
          await expect(executeMessageCall(failedMessageId, msgData, { executor: await ambBridgeContract.getAddress() })).eventually.to.equal(false)
          await expect(contract.requestFailedMessageFix(failedMessageId)).to.be.rejected
        })

        it('message sender should be mediator from other side', async () => {
          await expect(executeMessageCall(failedMessageId, msgData, { messageSender: await owner.getAddress() })).eventually.to.equal(false)
          await expect(contract.requestFailedMessageFix(failedMessageId)).to.be.rejected
        })

        it('should allow to request a fix multiple times', async () => {
          await expect(executeMessageCall(failedMessageId, msgData, { gas: 100 })).eventually.to.equal(false)
          await contract.requestFailedMessageFix(failedMessageId)
          await contract.requestFailedMessageFix(failedMessageId)
          const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
          expect(events.length).to.equal(2)
          expect(events[0].args.data.slice(0, 10)).to.equal(selectors.fixFailedMessage)
          expect(events[1].args.data.slice(0, 10)).to.equal(selectors.fixFailedMessage)
        })
      })

      describe('custom token pair', () => {
        it('should allow to set custom bridged token', async () => {
          const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          const deployedToken = await contract.bridgedTokenAddress(otherSideToken1)
          await expect(contract.setCustomTokenAddressPair(otherSideToken2, token)).to.be.rejected
          await expect(contract.setCustomTokenAddressPair(otherSideToken2, ambBridgeContract)).to.be.rejected
          await token.transferOwnership(await contract.getAddress())
          await expect(contract.connect(user).setCustomTokenAddressPair(otherSideToken2, token)).to.be.rejected
          await expect(contract.setCustomTokenAddressPair(otherSideToken1, token)).to.be.rejected
          await expect(contract.setCustomTokenAddressPair(otherSideToken2, deployedToken)).to.be.rejected
          await contract.setCustomTokenAddressPair(otherSideToken2, token)
          await expect(contract.setCustomTokenAddressPair(otherSideToken2, token)).to.be.rejected
          await expect(contract.bridgedTokenAddress(otherSideToken2)).eventually.to.equal(await token.getAddress())
          await expect(contract.nativeTokenAddress(token)).eventually.to.equal(otherSideToken2)
        })

        it('should not work for different decimals', async () => {
          token = await PermittableToken.deploy('Test', 'TST', 18, 1337)
          await token.transferOwnership(contract)
          await contract.setCustomTokenAddressPair(otherSideToken1, token)
          const deployArgs1 = [otherSideToken1, 'Test', 'TST', 20, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const deployArgs2 = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const data1 = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', deployArgs1)
          const data2 = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', deployArgs2)
          await expect(executeMessageCall(exampleMessageId, data1)).eventually.to.equal(false)
          await expect(executeMessageCall(otherMessageId, data2)).eventually.to.equal(true)
        })
      })
    })
  })
  if (isHome) {
    describe('fees management', () => {
      let homeToForeignFee!: string
      let foreignToHomeFee!: string
      let feeManager!: OmnibridgeFeeManager

      const deployContractsFeeManagement = async () => {
        await deployContracts()
        const homeOmnibridge = contract as HomeOmnibridge
        await initialize()
        feeManager = await OmnibridgeFeeManager.deploy(contract, owner, [owner], [ethers.parseEther('0.02'), ethers.parseEther('0.01')])
        await homeOmnibridge.connect(owner).setFeeManager(feeManager)
        const initialEvents = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
        expect(initialEvents.length).to.equal(0)
        homeToForeignFee = await feeManager.HOME_TO_FOREIGN_FEE()
        foreignToHomeFee = await feeManager.FOREIGN_TO_HOME_FEE()
      }

      beforeEach(async () => {
        await loadFixture(deployContractsFeeManagement)
      })

      it('change reward addresses', async () => {
        await expect(feeManager.connect(user).addRewardAddress(signers[8])).to.be.rejected
        await expect(feeManager.addRewardAddress(owner)).to.be.rejected
        await feeManager.addRewardAddress(signers[8])
        await expect(feeManager.rewardAddressList())
          .eventually.to.deep.equal([await owner.getAddress(), await signers[8].getAddress()])
        await expect(feeManager.rewardAddressCount())
          .eventually.to.equal('2')
        await expect(feeManager.isRewardAddress(owner))
          .eventually.to.equal(true)
        await expect(feeManager.isRewardAddress(signers[8]))
          .eventually.to.equal(true)
        await feeManager.addRewardAddress(signers[9])
        await expect(feeManager.rewardAddressList())
          .eventually.to.deep.equal([
            await owner.getAddress(),
            await signers[8].getAddress(),
            await signers[9].getAddress(),
          ])
        await expect(feeManager.rewardAddressCount())
          .eventually.to.equal('3')
        await expect(feeManager.connect(user).removeRewardAddress(owner)).to.be.rejected
        await expect(feeManager.removeRewardAddress(signers[7])).to.be.rejected
        await feeManager.removeRewardAddress(signers[8])
        await expect(feeManager.removeRewardAddress(signers[8])).to.be.rejected
        await expect(feeManager.rewardAddressList())
          .eventually.to.deep.equal([await owner.getAddress(), await signers[9].getAddress()])
        await expect(feeManager.rewardAddressCount())
          .eventually.to.equal('2')
        await expect(feeManager.isRewardAddress(signers[8]))
          .eventually.to.equal(false)
        await feeManager.removeRewardAddress(owner)
        await expect(feeManager.rewardAddressList())
          .eventually.to.deep.equal([await signers[9].getAddress()])
        await expect(feeManager.rewardAddressCount())
          .eventually.to.equal('1')
        await expect(feeManager.isRewardAddress(owner))
          .eventually.to.equal(false)
        await feeManager.removeRewardAddress(signers[9])
        await expect(feeManager.rewardAddressList())
          .eventually.to.deep.equal([])
        await expect(feeManager.rewardAddressCount())
          .eventually.to.equal('0')
        await expect(feeManager.isRewardAddress(signers[9]))
          .eventually.to.equal(false)
      })

      describe('initialize fees', () => {
        it('should initialize fees for native token', async () => {
          await token.connect(owner).mint(user, ethers.parseEther('10'))
          await token.connect(user).transferAndCall(contract, value, '0x')
          await expect(feeManager.getFee(homeToForeignFee, token)).eventually.to.equal(ethers.parseEther('0.02'))
          await expect(feeManager.getFee(foreignToHomeFee, token)).eventually.to.equal(ethers.parseEther('0.01'))
        })

        it('should initialize fees for bridged token', async () => {
          const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          const bridgedToken = await contract.bridgedTokenAddress(otherSideToken1)
          await expect(feeManager.getFee(homeToForeignFee, bridgedToken)).eventually.to.equal(ethers.parseEther('0.02'))
          await expect(feeManager.getFee(foreignToHomeFee, bridgedToken)).eventually.to.equal(ethers.parseEther('0.01'))
        })
      })

      describe('update fee parameters', () => {
        it('should update default fee value', async () => {
          await expect(feeManager.connect(user).setFee(homeToForeignFee, setup.ZERO_ADDRESS, ethers.parseEther('0.1'))).to.be.rejected
          await expect(feeManager.connect(owner).setFee(homeToForeignFee, setup.ZERO_ADDRESS, ethers.parseEther('1.1'))).to.be.rejected
          const tx = await feeManager.connect(owner).setFee(homeToForeignFee, setup.ZERO_ADDRESS, ethers.parseEther('0.1'))
          const logs = await logsFrom(feeManager, tx)
          utils.expectEventInLogs(logs, 'FeeUpdated')
          await expect(feeManager.getFee(homeToForeignFee, setup.ZERO_ADDRESS)).eventually.to.equal(ethers.parseEther('0.1'))
          await expect(feeManager.getFee(foreignToHomeFee, setup.ZERO_ADDRESS)).eventually.to.equal(ethers.parseEther('0.01'))
        })

        it('should update default opposite direction fee value', async () => {
          await expect(feeManager.connect(user).setFee(foreignToHomeFee, setup.ZERO_ADDRESS, ethers.parseEther('0.1'))).to.be.rejected
          await expect(feeManager.connect(owner).setFee(foreignToHomeFee, setup.ZERO_ADDRESS, ethers.parseEther('1.1'))).to.be.rejected
          const tx = await feeManager.connect(owner).setFee(foreignToHomeFee, setup.ZERO_ADDRESS, ethers.parseEther('0.1'))
          const logs = await logsFrom(feeManager, tx)
          utils.expectEventInLogs(logs, 'FeeUpdated')
          await expect(feeManager.getFee(foreignToHomeFee, setup.ZERO_ADDRESS)).eventually.to.equal(ethers.parseEther('0.1'))
          await expect(feeManager.getFee(homeToForeignFee, setup.ZERO_ADDRESS)).eventually.to.equal(ethers.parseEther('0.02'))
        })

        it('should update fee value for native token', async () => {
          await token.connect(owner).mint(user, ethers.parseEther('10'))
          await token.connect(user).transferAndCall(contract, value, '0x')
          await expect(feeManager.connect(user).setFee(homeToForeignFee, token, ethers.parseEther('0.1'))).to.be.rejected
          await expect(feeManager.connect(owner).setFee(homeToForeignFee, token, ethers.parseEther('1.1'))).to.be.rejected
          const tx1 = await feeManager.connect(owner).setFee(homeToForeignFee, token, ethers.parseEther('0.1'))
          const logs1 = await logsFrom(feeManager, tx1)
          const tx2 = await feeManager.connect(owner).setFee(foreignToHomeFee, token, ethers.parseEther('0.2'))
          const logs2 = await logsFrom(feeManager, tx2)
          utils.expectEventInLogs(logs1, 'FeeUpdated')
          utils.expectEventInLogs(logs2, 'FeeUpdated')
          await expect(feeManager.getFee(homeToForeignFee, token)).eventually.to.equal(ethers.parseEther('0.1'))
          await expect(feeManager.getFee(foreignToHomeFee, token)).eventually.to.equal(ethers.parseEther('0.2'))
        })

        it('should update fee value for bridged token', async () => {
          const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
            AddressLike,
            string,
            string,
            BigNumberish,
            AddressLike,
            BigNumberish
          ]
          const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
          await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
          const bridgedToken = await contract.bridgedTokenAddress(otherSideToken1)
          await expect(feeManager.connect(user).setFee(homeToForeignFee, bridgedToken, ethers.parseEther('0.1'))).to.be.rejected
          await expect(feeManager.connect(owner).setFee(homeToForeignFee, bridgedToken, ethers.parseEther('1.1'))).to.be.rejected
          const tx1 = await feeManager.connect(owner).setFee(homeToForeignFee, bridgedToken, ethers.parseEther('0.1'))
          const logs1 = await logsFrom(feeManager, tx1)
          const tx2 = await feeManager.connect(owner).setFee(foreignToHomeFee, bridgedToken, ethers.parseEther('0.2'))
          const logs2 = await logsFrom(feeManager, tx2)
          utils.expectEventInLogs(logs1, 'FeeUpdated')
          utils.expectEventInLogs(logs2, 'FeeUpdated')
          await expect(feeManager.getFee(homeToForeignFee, bridgedToken)).eventually.to.equal(ethers.parseEther('0.1'))
          await expect(feeManager.getFee(foreignToHomeFee, bridgedToken)).eventually.to.equal(ethers.parseEther('0.2'))
        })
      })
      function testHomeToForeignFee(isNative: boolean) {
        it('should collect and distribute 0% fee', async () => {
          await feeManager.setFee(homeToForeignFee, isNative ? setup.ZERO_ADDRESS : token, 0n)
          await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(0n)
          await token.connect(user).transferAndCall(contract, value, '0x')
          await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(value)
          await expect(token.balanceOf(contract)).eventually.to.equal(isNative ? ethers.parseEther('1') : 0n)
          await token.connect(user).transferAndCall(contract, value, '0x')
          await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(twoEthers)
          await expect(token.balanceOf(contract)).eventually.to.equal(isNative ? ethers.parseEther('2') : 0n)
          const feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
          expect(feeEvents.length).to.equal(0)
        })
        it('should collect and distribute 2% fee', async () => {
          await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(0n)
          await token.connect(user).transferAndCall(contract, value, '0x')
          await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(value)
          await expect(token.balanceOf(contract)).eventually.to.equal(isNative ? ethers.parseEther('0.98') : 0n)
          await expect(token.balanceOf(owner)).eventually.to.equal(ethers.parseEther('0.02'))
          await token.connect(user).transferAndCall(contract, value, '0x')
          await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(twoEthers)
          await expect(token.balanceOf(contract)).eventually.to.equal(isNative ? ethers.parseEther('1.96') : 0n)
          await expect(token.balanceOf(owner)).eventually.to.equal(ethers.parseEther('0.04'))
          const feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
          expect(feeEvents.length).to.equal(2)
        })
        it('should collect and distribute 2% fee between two reward addresses', async () => {
          await feeManager.addRewardAddress(signers[9])
          await expect(feeManager.rewardAddressCount()).eventually.to.equal('2')
          await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(0n)
          await expect(token.connect(user).transferAndCall(contract, ethers.parseEther('0.100000000000000050'), '0x')).to.be
            .fulfilled
          await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(ethers.parseEther('0.100000000000000050'))
          await expect(token.balanceOf(contract)).eventually.to.equal(isNative ? ethers.parseEther('0.098000000000000049') : 0n)
          const balance1 = (await token.balanceOf(owner)).toString()
          const balance2 = (await token.balanceOf(signers[9])).toString()
          expect((balance1 === '1000000000000001' && balance2 === '1000000000000000') ||
            (balance1 === '1000000000000000' && balance2 === '1000000000000001')).to.equal(true)
          await token.connect(user).transferAndCall(contract, value, '0x')
          await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(ethers.parseEther('1.100000000000000050'))
          await expect(token.balanceOf(contract)).eventually.to.equal(isNative ? ethers.parseEther('1.078000000000000049') : 0n)
          const feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
          expect(feeEvents.length).to.equal(2)
        })
        it('should not collect and distribute fee if sender is a reward address', async () => {
          await token.connect(user).transferAndCall(owner, value, '0x')
          await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(0n)
          await token.connect(owner).transferAndCall(contract, value, '0x')
          await expect(contract.totalSpentPerDay(token, currentDay)).eventually.to.equal(value)
          await expect(token.balanceOf(contract)).eventually.to.equal(isNative ? ethers.parseEther('1') : 0n)
          await expect(token.balanceOf(owner)).eventually.to.equal(0n)
          const feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
          expect(feeEvents.length).to.equal(0)
        })
      }

      describe('distribute fee for native tokens', () => {
        describe('distribute fee for home => foreign direction', () => {
          beforeEach(async () => {
            await token.mint(user, ethers.parseEther('10'))
          })
          testHomeToForeignFee(true)
        })

        describe('distribute fee for foreign => home direction', () => {
          beforeEach(async () => {
            await feeManager.setFee(homeToForeignFee, setup.ZERO_ADDRESS, 0n)
            await token.connect(owner).mint(user, ethers.parseEther('10'))
            await token.connect(user).transferAndCall(contract, value, '0x')
            await token.connect(user).transferAndCall(contract, value, '0x')
          })

          it('should collect and distribute 0% fee', async () => {
            await feeManager.setFee(foreignToHomeFee, token, 0n)
            const data = contract.interface.encodeFunctionData('handleNativeTokens', [
              await token.getAddress(),
              await user.getAddress(),
              value,
            ])
            await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
            let event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
            expect(event.length).to.equal(1)
            expect(event[0].args.token).to.equal(token)
            expect(event[0].args.recipient).to.equal(user)
            expect(event[0].args.value).to.equal(value.toString())
            expect(event[0].args.messageId).to.equal(exampleMessageId)
            let feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
            expect(feeEvents.length).to.equal(0)
            await expect(executeMessageCall(otherMessageId, data)).eventually.to.equal(true)
            await expect(contract.totalExecutedPerDay(token, currentDay)).eventually.to.equal(twoEthers)
            event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
            expect(event.length).to.equal(2)
            expect(event[1].args.token).to.equal(token)
            expect(event[1].args.recipient).to.equal(user)
            expect(event[1].args.value).to.equal(value.toString())
            expect(event[1].args.messageId).to.equal(otherMessageId)
            feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
            expect(feeEvents.length).to.equal(0)
            await expect(token.balanceOf(user)).eventually.to.equal(ethers.parseEther('10'))
            await expect(token.balanceOf(contract)).eventually.to.equal(0n)
            await expect(token.balanceOf(owner)).eventually.to.equal(0n)
          })

          it('should collect and distribute 1% fee', async () => {
            const data = contract.interface.encodeFunctionData('handleNativeTokens', [
              await token.getAddress(),
              await user.getAddress(),
              value,
            ])
            await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
            let event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
            expect(event.length).to.equal(1)
            expect(event[0].args.token).to.equal(token)
            expect(event[0].args.recipient).to.equal(user)
            expect(event[0].args.value).to.equal(ethers.parseEther('0.99').toString())
            expect(event[0].args.messageId).to.equal(exampleMessageId)
            let feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
            expect(feeEvents.length).to.equal(1)
            await expect(token.balanceOf(user)).eventually.to.equal(ethers.parseEther('8.99'))
            await expect(token.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
            await expect(token.balanceOf(owner)).eventually.to.equal(ethers.parseEther('0.01'))
            await expect(executeMessageCall(otherMessageId, data)).eventually.to.equal(true)
            await expect(contract.totalExecutedPerDay(token, currentDay)).eventually.to.equal(twoEthers)
            event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
            expect(event.length).to.equal(2)
            expect(event[1].args.token).to.equal(token)
            expect(event[1].args.recipient).to.equal(user)
            expect(event[1].args.value).to.equal(ethers.parseEther('0.99').toString())
            expect(event[1].args.messageId).to.equal(otherMessageId)
            feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
            expect(feeEvents.length).to.equal(2)
            await expect(token.balanceOf(user)).eventually.to.equal(ethers.parseEther('9.98'))
            await expect(token.balanceOf(contract)).eventually.to.equal(0n)
            await expect(token.balanceOf(owner)).eventually.to.equal(ethers.parseEther('0.02'))
          })

          it('should collect and distribute 1% fee between two reward addresses', async () => {
            await feeManager.addRewardAddress(signers[9])
            await expect(feeManager.rewardAddressCount()).eventually.to.equal('2')
            const data = contract.interface.encodeFunctionData('handleNativeTokens', [
              await token.getAddress(),
              await user.getAddress(),
              ethers.parseEther('0.200000000000000100'),
            ])
            await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
            let event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
            expect(event.length).to.equal(1)
            let feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
            expect(feeEvents.length).to.equal(1)
            await expect(token.balanceOf(user)).eventually.to.equal(ethers.parseEther('8.198000000000000099'))
            await expect(token.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1.799999999999999900'))
            const balance1 = (await token.balanceOf(owner)).toString()
            const balance2 = (await token.balanceOf(signers[9])).toString()
            expect((balance1 === '1000000000000001' && balance2 === '1000000000000000') ||
              (balance1 === '1000000000000000' && balance2 === '1000000000000001')).to.equal(true)
            await expect(executeMessageCall(otherMessageId, data)).eventually.to.equal(true)
            await expect(contract.totalExecutedPerDay(await token.getAddress(), currentDay)).eventually.to.equal(ethers.parseEther('0.400000000000000200'))
            event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
            expect(event.length).to.equal(2)
            feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
            expect(feeEvents.length).to.equal(2)
          })
        })
      })

      describe('distribute fee for bridged tokens', () => {
        describe('distribute fee for foreign => home direction', () => {
          it('should collect and distribute 0% fee', async () => {
            await feeManager.setFee(foreignToHomeFee, setup.ZERO_ADDRESS, 0n)
            const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
              AddressLike,
              string,
              string,
              BigNumberish,
              AddressLike,
              BigNumberish
            ]
            const deployData = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
            await expect(executeMessageCall(exampleMessageId, deployData)).eventually.to.equal(true)
            const bridgedToken = PermittableToken.attach(await contract.bridgedTokenAddress(otherSideToken1)) as PermittableToken
            let event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
            expect(event.length).to.equal(1)
            expect(event[0].args.token).to.equal(bridgedToken)
            expect(event[0].args.recipient).to.equal(user)
            expect(event[0].args.value).to.equal(value.toString())
            expect(event[0].args.messageId).to.equal(exampleMessageId)
            let feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
            expect(feeEvents.length).to.equal(0)
            const data = contract.interface.encodeFunctionData('handleBridgedTokens', [
              otherSideToken1, await user.getAddress(), value.toString()
            ])
            await expect(executeMessageCall(otherMessageId, data)).eventually.to.equal(true)
            await expect(contract.totalExecutedPerDay(bridgedToken, currentDay)).eventually.to.equal(twoEthers)
            event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
            expect(event.length).to.equal(2)
            expect(event[1].args.token).to.equal(bridgedToken)
            expect(event[1].args.recipient).to.equal(user)
            expect(event[1].args.value).to.equal(value.toString())
            expect(event[1].args.messageId).to.equal(otherMessageId)
            feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
            expect(feeEvents.length).to.equal(0)
            await expect(bridgedToken.balanceOf(user)).eventually.to.equal(twoEthers)
            await expect(bridgedToken.balanceOf(contract)).eventually.to.equal(0n)
            await expect(bridgedToken.balanceOf(owner)).eventually.to.equal(0n)
          })

          it('should collect and distribute 1% fee', async () => {
            const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
              AddressLike,
              string,
              string,
              BigNumberish,
              AddressLike,
              BigNumberish
            ]
            const deployData = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
            await expect(executeMessageCall(exampleMessageId, deployData)).eventually.to.equal(true)
            const bridgedToken = PermittableToken.attach(await contract.bridgedTokenAddress(otherSideToken1)) as PermittableToken
            let event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
            expect(event.length).to.equal(1)
            expect(event[0].args.token).to.equal(bridgedToken)
            expect(event[0].args.recipient).to.equal(user)
            expect(event[0].args.value).to.equal(ethers.parseEther('0.99').toString())
            expect(event[0].args.messageId).to.equal(exampleMessageId)
            let feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
            expect(feeEvents.length).to.equal(1)
            await expect(bridgedToken.balanceOf(user)).eventually.to.equal(ethers.parseEther('0.99'))
            await expect(bridgedToken.balanceOf(contract)).eventually.to.equal(0n)
            await expect(bridgedToken.balanceOf(owner)).eventually.to.equal(ethers.parseEther('0.01'))
            const data = contract.interface.encodeFunctionData('handleBridgedTokens', [
              otherSideToken1, await user.getAddress(), value.toString()
            ])
            await expect(executeMessageCall(otherMessageId, data)).eventually.to.equal(true)
            await expect(contract.totalExecutedPerDay(bridgedToken, currentDay)).eventually.to.equal(twoEthers)
            event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
            expect(event.length).to.equal(2)
            expect(event[1].args.token).to.equal(bridgedToken)
            expect(event[1].args.recipient).to.equal(user)
            expect(event[1].args.value).to.equal(ethers.parseEther('0.99').toString())
            expect(event[1].args.messageId).to.equal(otherMessageId)
            feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
            expect(feeEvents.length).to.equal(2)
            await expect(bridgedToken.balanceOf(user)).eventually.to.equal(ethers.parseEther('1.98'))
            await expect(bridgedToken.balanceOf(contract)).eventually.to.equal(0n)
            await expect(bridgedToken.balanceOf(owner)).eventually.to.equal(ethers.parseEther('0.02'))
          })

          it('should collect and distribute 1% fee between two reward addresses', async () => {
            await feeManager.addRewardAddress(signers[9])
            await expect(feeManager.rewardAddressCount()).eventually.to.equal('2')
            const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), ethers.parseEther('0.200000000000000100')] as [
              AddressLike,
              string,
              string,
              BigNumberish,
              AddressLike,
              BigNumberish
            ]
            const deployData = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
            await expect(executeMessageCall(exampleMessageId, deployData)).eventually.to.equal(true)
            const bridgedToken = PermittableToken.attach(await contract.bridgedTokenAddress(otherSideToken1)) as PermittableToken
            let event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
            expect(event.length).to.equal(1)
            let feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
            expect(feeEvents.length).to.equal(1)
            await expect(bridgedToken.balanceOf(user)).eventually.to.equal(ethers.parseEther('0.198000000000000099'))
            await expect(bridgedToken.balanceOf(contract)).eventually.to.equal(0n)
            const balance1 = (await bridgedToken.balanceOf(owner)).toString()
            const balance2 = (await bridgedToken.balanceOf(signers[9])).toString()
            expect((balance1 === '1000000000000001' && balance2 === '1000000000000000') ||
              (balance1 === '1000000000000000' && balance2 === '1000000000000001')).to.equal(true)
            const data = contract.interface.encodeFunctionData('handleBridgedTokens', [
              otherSideToken1, await user.getAddress(), ethers.parseEther('0.200000000000000100').toString(10)
            ])
            await expect(executeMessageCall(otherMessageId, data)).eventually.to.equal(true)
            await expect(contract.totalExecutedPerDay(bridgedToken, currentDay)).eventually.to.equal(ethers.parseEther('0.400000000000000200'))
            event = await utils.getEvents<TokensBridgedEvent.Event>(contract, 'TokensBridged')
            expect(event.length).to.equal(2)
            feeEvents = await utils.getEvents<FeeDistributedEvent.Event>(contract, 'FeeDistributed')
            expect(feeEvents.length).to.equal(2)
          })
        })

        describe('distribute fee for home => foreign direction', () => {
          beforeEach(async () => {
            await feeManager.setFee(foreignToHomeFee, setup.ZERO_ADDRESS, 0n)
            const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
              AddressLike,
              string,
              string,
              BigNumberish,
              AddressLike,
              BigNumberish
            ]
            const deployData = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
            await expect(executeMessageCall(exampleMessageId, deployData)).eventually.to.equal(true)
            await expect(executeMessageCall(exampleMessageId, deployData)).eventually.to.equal(true)
            token = PermittableToken.attach(await contract.bridgedTokenAddress(otherSideToken1)) as PermittableToken
          })
          testHomeToForeignFee(false)
        })
      })
    })
    describe('oracle driven lane permissions', () => {
      let manager!: MultiTokenForwardingRulesManager

      const deployContractsOracle = async () => {
        await deployContracts()
        manager = await MultiTokenForwardingRulesManager.deploy(owner)
        await expect(manager.owner()).eventually.to.equal(owner)
      }

      beforeEach(async () => {
        await loadFixture(deployContractsOracle)
      })

      it('should allow to update manager address', async () => {
        await initialize()
        const homeOmnibridge = contract as HomeOmnibridge
        await expect(homeOmnibridge.connect(user).setForwardingRulesManager(manager)).to.be.rejected
        await homeOmnibridge.connect(owner).setForwardingRulesManager(manager)
        await expect(homeOmnibridge.forwardingRulesManager()).eventually.to.equal(manager)
        const otherManager = await MultiTokenForwardingRulesManager.deploy(homeOmnibridge)
        await homeOmnibridge.setForwardingRulesManager(otherManager)
        await expect(homeOmnibridge.forwardingRulesManager()).eventually.to.equal(otherManager)
        await expect(homeOmnibridge.setForwardingRulesManager(owner)).to.be.reverted
        await homeOmnibridge.setForwardingRulesManager(setup.ZERO_ADDRESS)
        await expect(homeOmnibridge.forwardingRulesManager()).eventually.to.equal(setup.ZERO_ADDRESS)
      })

      it('should allow to set/update lane permissions', async () => {
        await expect(manager.destinationLane(token, user, user2)).eventually.to.equal('0')
        await expect(manager.connect(user).setTokenForwardingRule(token, true)).to.be.rejected
        await manager.connect(owner).setTokenForwardingRule(token, true)
        await expect(manager.destinationLane(token, user, user2)).eventually.to.equal('1')
        await expect(manager.connect(user).setSenderExceptionForTokenForwardingRule(token, user, true)).to.be
          .rejected
        await expect(manager.connect(owner).setSenderExceptionForTokenForwardingRule(token, user, true)).to.be
          .fulfilled
        await expect(manager.destinationLane(token, user, user2)).eventually.to.equal('-1')
        await expect(manager.destinationLane(token, user2, user2)).eventually.to.equal('1')
        await expect(manager.connect(owner).setSenderExceptionForTokenForwardingRule(token, user, false)).to.be
          .fulfilled
        await expect(manager.connect(user).setReceiverExceptionForTokenForwardingRule(token, user, true)).to.be
          .rejected
        await expect(manager.connect(owner).setReceiverExceptionForTokenForwardingRule(token, user, true)).to.be
          .fulfilled
        await expect(manager.destinationLane(token, user, user)).eventually.to.equal('-1')
        await expect(manager.destinationLane(token, user, user2)).eventually.to.equal('1')
        await manager.connect(owner).setTokenForwardingRule(token, false)
        await expect(manager.destinationLane(token, user2, user2)).eventually.to.equal('0')
        await expect(manager.connect(user).setSenderForwardingRule(user2, true)).to.be.rejected
        await manager.connect(owner).setSenderForwardingRule(user2, true)
        await expect(manager.destinationLane(token, user2, user2)).eventually.to.equal('1')
        await expect(manager.connect(user).setReceiverForwardingRule(user2, true)).to.be.rejected
        await manager.connect(owner).setReceiverForwardingRule(user2, true)
        await expect(manager.destinationLane(token, user, user2)).eventually.to.equal('1')
      })

      it('should send a message to the oracle-driven lane', async () => {
        await initialize()
        const homeOmnibridge = contract as HomeOmnibridge
        await token.connect(owner).mint(user, ethers.parseEther('10'))
        const args = [otherSideToken1, 'Test', 'TST', 18, await user.getAddress(), value] as [
          AddressLike,
          string,
          string,
          BigNumberish,
          AddressLike,
          BigNumberish
        ]
        const data = contract.interface.encodeFunctionData('deployAndHandleBridgedTokens', args)
        await expect(executeMessageCall(exampleMessageId, data)).eventually.to.equal(true)
        const bridgedToken = PermittableToken.attach(await contract.bridgedTokenAddress(otherSideToken1)) as PermittableToken
        await token.connect(user).transferAndCall(contract, ethers.parseEther('0.1'), '0x')
        await bridgedToken.connect(user).transferAndCall(contract, ethers.parseEther('0.1'), '0x')
        await homeOmnibridge.connect(owner).setForwardingRulesManager(manager)
        await token.connect(user).transferAndCall(contract, ethers.parseEther('0.1'), '0x')
        await bridgedToken.connect(user).transferAndCall(contract, ethers.parseEther('0.1'), '0x')
        await manager.connect(owner).setTokenForwardingRule(token, true)
        await manager.connect(owner).setTokenForwardingRule(bridgedToken, true)
        await token.connect(user).transferAndCall(contract, ethers.parseEther('0.1'), '0x')
        await bridgedToken.connect(user).transferAndCall(contract, ethers.parseEther('0.1'), '0x')
        const events = await utils.getEvents<MockedEventEvent.Event>(ambBridgeContract, 'MockedEvent')
        expect(events.length).to.equal(6)
        expect(events[0].args.dataType).to.equal('0')
        expect(events[1].args.dataType).to.equal('0')
        expect(events[2].args.dataType).to.equal('128')
        expect(events[3].args.dataType).to.equal('128')
        expect(events[4].args.dataType).to.equal('0')
        expect(events[5].args.dataType).to.equal('0')
      })
    })
  }
  if (!isHome) {
    describe('compound connector', () => {
      let faucet!: ethers.Signer
      let dai!: IERC20
      let cDai!: ICToken
      let comptroller!: IHarnessComptroller
      let comp!: IERC20
      let daiInterestImpl!: CompoundInterestERC20
      let foreignOmnibridge!: ForeignOmnibridge

      const deployContractsCompound: TestFn = async function () {
        await deployContracts()
        const contracts = await getCompoundContracts()
        if (!(await contracts.comptroller.getDeployedCode())) {
          console.log('compound contracts missing');
          this.skip()
        }
        faucet = signers[6]
        dai = contracts.dai
        cDai = contracts.cDai
        comptroller = contracts.comptroller
        comp = contracts.comp
        const storageProxy = await EternalStorageProxy.deploy()
        await storageProxy.upgradeTo('1', contract)
        contract = Mediator.attach(await storageProxy.getAddress()) as ForeignOmnibridge
        foreignOmnibridge = contract
        await initialize({
          limits: [ethers.parseEther('100'), ethers.parseEther('99'), ethers.parseEther('0.01')],
          executionLimits: [ethers.parseEther('100'), ethers.parseEther('99')],
        })
        daiInterestImpl = await CompoundInterestERC20.deploy(
          await contract.getAddress(), await owner.getAddress(),
          1, await signers[2].getAddress(),
        )
        await daiInterestImpl.connect(owner).enableInterestToken(
          await cDai.getAddress(), oneEther,
          await signers[2].getAddress(), ethers.parseEther('0.01'),
        )
        await dai.connect(faucet).approve(contract, ethers.parseEther('100'))
        await contract.connect(faucet).getFunction('relayTokens(address,uint256)')(dai, ethers.parseEther('10'))
      }

      beforeEach(async function () {
        await loadFixture(deployContractsCompound)
      })
      async function generateInterest() {
        await cDai.connect(faucet).borrow(ethers.parseEther('10'))
        await comptroller.fastForward(200_000)
        await cDai.connect(faucet).repayBorrow(ethers.parseEther('20'))
      }

      it('should initialize interest', async () => {
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('10'))
        await expect(foreignOmnibridge.interestImplementation(dai)).eventually.to.equal(setup.ZERO_ADDRESS)
        const args = [await dai.getAddress(), await daiInterestImpl.getAddress(), oneEther] as [AddressLike, AddressLike, BigNumberish]
        await expect(foreignOmnibridge.connect(user).initializeInterest(...args)).to.be.rejected
        await foreignOmnibridge.connect(owner).initializeInterest(...args)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('10'))
        await expect(cDai.balanceOf(contract)).eventually.to.equal(0n)
        await expect(foreignOmnibridge.interestImplementation(dai)).eventually.to.equal(daiInterestImpl)
        await expect(foreignOmnibridge.minCashThreshold(dai)).eventually.to.equal(oneEther)
      })

      it('should enable and earn interest', async () => {
        const initialBalance = await dai.balanceOf(signers[2])
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await expect(daiInterestImpl.interestAmount.staticCall(dai)).eventually.to.equal(0n)
        await foreignOmnibridge.invest(dai)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(dai.balanceOf(signers[2])).eventually.to.equal(initialBalance)
        await expect(dai.balanceOf(daiInterestImpl)).eventually.to.equal(0n)
        await expect(cDai.balanceOf(daiInterestImpl)).eventually.to.be.gt(0)
        await expect(daiInterestImpl.interestAmount.staticCall(dai)).eventually.to.equal(0n)
        await generateInterest()
        await expect(daiInterestImpl.interestAmount.staticCall(dai)).eventually.to.be.gt(0)
      })

      it('should pay interest', async () => {
        const initialBalance = await dai.balanceOf(signers[2])
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await generateInterest()
        await expect(daiInterestImpl.interestAmount.staticCall(dai)).eventually.to.be.gt(ethers.parseEther('0.01') as unknown as number)
        await daiInterestImpl.payInterest(dai)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(dai.balanceOf(signers[2])).eventually.to.be.gt(initialBalance as unknown as number)
        await expect(cDai.balanceOf(daiInterestImpl)).eventually.to.be.gt(0)
        await expect(daiInterestImpl.interestAmount.staticCall(dai)).eventually.to.be.lt(ethers.parseEther('0.01') as unknown as number)
      })

      it('should disable interest', async () => {
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await generateInterest()
        await daiInterestImpl.payInterest(dai)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(foreignOmnibridge.connect(user).disableInterest(dai)).to.be.rejected
        await foreignOmnibridge.connect(owner).disableInterest(dai)
        await expect(foreignOmnibridge.interestImplementation(dai)).eventually.to.equal(setup.ZERO_ADDRESS)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('10'))
        await expect(cDai.balanceOf(daiInterestImpl)).eventually.to.be.gt(0n as unknown as number)
      })

      it('configuration', async () => {
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await expect(foreignOmnibridge.connect(user).setMinCashThreshold(dai, ethers.parseEther('2'))).to.be.rejected
        await foreignOmnibridge.connect(owner).setMinCashThreshold(dai, ethers.parseEther('2'))
        await expect(foreignOmnibridge.minCashThreshold(dai)).eventually.to.equal(ethers.parseEther('2'))
        await expect(daiInterestImpl.connect(user).setDust(dai, '1')).to.be.rejected
        await daiInterestImpl.connect(owner).setDust(dai, '1')
        const res0 = await daiInterestImpl.interestParams(dai)
        expect(res0.dust).to.equal(1n)
        await expect(daiInterestImpl.connect(user).setMinInterestPaid(dai, oneEther)).to.be.rejected
        await daiInterestImpl.connect(owner).setMinInterestPaid(dai, oneEther)
        const res1 = await daiInterestImpl.interestParams(dai)
        expect(res1.minInterestPaid).to.equal(oneEther)
        await expect(daiInterestImpl.connect(user).setInterestReceiver(dai, signers[1])).to.be.rejected
        await daiInterestImpl.connect(owner).setInterestReceiver(dai, signers[1])
        const res2 = await daiInterestImpl.interestParams(dai)
        await expect(signers[1].getAddress()).eventually.to.equal(res2.interestReceiver)
        await expect(daiInterestImpl.connect(user).setMinCompPaid(oneEther)).to.be.rejected
        await daiInterestImpl.connect(owner).setMinCompPaid(oneEther)
        await expect(daiInterestImpl.minCompPaid()).eventually.to.equal(oneEther)
        await expect(daiInterestImpl.connect(user).setCompReceiver(user)).to.be.rejected
        await daiInterestImpl.connect(owner).setCompReceiver(user)
        await expect(daiInterestImpl.compReceiver()).eventually.to.equal(await user.getAddress())
      })

      it('should claim comp', async () => {
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await generateInterest()
        const initialBalance = await comp.balanceOf(signers[2])
        await expect(daiInterestImpl.compAmount.staticCall([cDai])).eventually.to.be.gt(0)
        await daiInterestImpl.claimCompAndPay([cDai])
        await expect(daiInterestImpl.compAmount.staticCall([cDai])).eventually.to.equal(0n)
        await expect(comp.balanceOf(signers[2])).eventually.to.be.gt(initialBalance as unknown as number)
      })

      it('should return invested tokens on withdrawal if needed', async () => {
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('9'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('10'))
        const data1 = foreignOmnibridge.interface.encodeFunctionData('handleNativeTokens', [
          await dai.getAddress(),
          await user.getAddress(),
          ethers.parseEther('0.5'),
        ])
        await expect(executeMessageCall(exampleMessageId, data1)).eventually.to.equal(true)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('0.5'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('9.5'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('9'))
        const data2 = foreignOmnibridge.interface.encodeFunctionData('handleNativeTokens', [
          await dai.getAddress(),
          await user.getAddress(),
          ethers.parseEther('2'),
        ])
        await expect(executeMessageCall(otherMessageId, data2)).eventually.to.equal(true)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('7.5'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('6.5'))
      })

      it('should allow to fix correct amount of tokens when compound is used', async () => {
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('9'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('10'))
        await dai.connect(faucet).transfer(contract, ethers.parseEther('1'))
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('2'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('9'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('10'))
        await contract.connect(owner).fixMediatorBalance(dai, owner)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('2'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('9'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('11'))
      })

      it('should force disable interest implementation', async () => {
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('9'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('10'))
        await expect(daiInterestImpl.connect(user).forceDisable(dai)).to.be.rejected
        await daiInterestImpl.connect(owner).forceDisable(dai)
        await expect(dai.balanceOf(contract)).eventually.to.be.gt(ethers.parseEther('9.999') as unknown as number)
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('0'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('10'))
      })

      it('should allow to reinitialize when there are no invested funds', async () => {
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await generateInterest()
        await expect(daiInterestImpl.enableInterestToken(cDai, oneEther, signers[2], ethers.parseEther('0.01'))).to.be.rejected
        await foreignOmnibridge.connect(owner).disableInterest(dai)
        await daiInterestImpl.enableInterestToken(cDai, oneEther, signers[2], ethers.parseEther('0.01'))
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
      })
    })
    describe('aave connector', () => {
      let dai!: IMintableERC20
      let usdc!: IMintableERC20
      let aDai!: IERC20
      let lendingPool!: ILendingPool
      let incentivesController!: IStakedTokenIncentivesController
      let aave!: IMintableERC20
      let stkAAVE!: IStakedAave
      let daiInterestImpl!: AAVEInterestERC20
      let borrower!: ethers.Signer

      const deployContractsAave: TestFn = async function () {
        await deployContracts()
        const contracts = await getAAVEContracts(hre, signers[8])
        if (!(await contracts.aave.getDeployedCode())) {
          console.log('aave contracts missing')
          this.skip()
        }
        borrower = signers[2]
        dai = contracts.dai
        usdc = contracts.usdc
        aDai = contracts.aDai
        lendingPool = contracts.lendingPool
        incentivesController = contracts.incentivesController
        aave = contracts.aave
        stkAAVE = contracts.stkAAVE
        // create some preliminary deposit
        await dai.mint(ethers.parseEther('10000000'))
        await dai.approve(lendingPool, ethers.parseEther('10000000'))
        await lendingPool.deposit(dai, ethers.parseEther('10000'), owner, 0)
        // create collateral for borrower account
        await usdc.mint(ethers.parseEther('1000000000'))
        await usdc.approve(lendingPool, ethers.parseEther('1000000000'))
        await lendingPool.deposit(usdc, ethers.parseEther('1000000000'), borrower, 0)

        const storageProxy = await EternalStorageProxy.deploy()
        await storageProxy.upgradeTo('1', contract)
        contract = Mediator.attach(await storageProxy.getAddress()) as ForeignOmnibridge | HomeOmnibridge
        await initialize({
          limits: [ethers.parseEther('100'), ethers.parseEther('99'), ethers.parseEther('0.01')],
          executionLimits: [ethers.parseEther('100'), ethers.parseEther('99')],
        })
        daiInterestImpl = await AAVEInterestERC20.deploy(contract, owner, 1, signers[2])
        await daiInterestImpl.enableInterestToken(dai, '1', signers[2], ethers.parseEther('0.01'))
        await dai.approve(contract, ethers.parseEther('100'))
        await contract.getFunction('relayTokens(address,uint256)')(dai, ethers.parseEther('10'))
      }

      beforeEach(async function () {
        await loadFixture(deployContractsAave)
      })
      async function generateInterest() {
        const block = await hre.ethers.provider.getBlock('latest') as ethers.Block
        const repayTimestamp = (block.timestamp + (356 * 24 * 60 * 60))
        await lendingPool.connect(borrower).borrow(dai, ethers.parseEther('1000'), 1, 0, borrower)
        await mineBlock(repayTimestamp)
        await lendingPool.repay(dai, ethers.parseEther('1000000'), 1, borrower); // repay whole debt
      }

      it('should initialize interest', async () => {
        const foreignOmnibridge = contract as ForeignOmnibridge
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('10'))
        await expect(foreignOmnibridge.interestImplementation(dai)).eventually.to.equal(setup.ZERO_ADDRESS)
        const args = [dai, daiInterestImpl, oneEther] as [AddressLike, AddressLike, BigNumberish]
        await expect(foreignOmnibridge.connect(user).initializeInterest(...args)).to.be.rejected
        await foreignOmnibridge.connect(owner).initializeInterest(...args)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('10'))
        await expect(aDai.balanceOf(contract)).eventually.to.equal(0n)
        await expect(foreignOmnibridge.interestImplementation(dai)).eventually.to.equal(await daiInterestImpl.getAddress())
        await expect(foreignOmnibridge.minCashThreshold(await dai.getAddress())).eventually.to.equal(oneEther)
      })

      it('should enable and earn interest', async () => {
        const foreignOmnibridge = contract as ForeignOmnibridge
        const initialBalance = await dai.balanceOf(signers[2])
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await expect(daiInterestImpl.interestAmount.staticCall(dai)).eventually.to.equal(0n)
        await foreignOmnibridge.invest(dai)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(dai.balanceOf(signers[2])).eventually.to.equal(initialBalance)
        await expect(dai.balanceOf(daiInterestImpl)).eventually.to.equal(0n)
        await expect(aDai.balanceOf(daiInterestImpl)).eventually.to.be.gt(0)
        await expect(daiInterestImpl.interestAmount.staticCall(dai)).eventually.to.equal(0n)
        await generateInterest()
        await expect(daiInterestImpl.interestAmount.staticCall(dai)).eventually.to.be.gt(0n as unknown as number)
      })

      it('should pay interest', async () => {
        const foreignOmnibridge = contract as ForeignOmnibridge
        const initialBalance = await dai.balanceOf(signers[2])
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await generateInterest()
        await expect(daiInterestImpl.interestAmount.staticCall(dai)).eventually.to.be.gt(ethers.parseEther('0.01') as unknown as number)
        await daiInterestImpl.payInterest(dai)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(dai.balanceOf(signers[2])).eventually.to.be.gt(initialBalance as unknown as number)
        await expect(aDai.balanceOf(daiInterestImpl)).eventually.to.be.gt(0)
        await expect(daiInterestImpl.interestAmount.staticCall(dai)).eventually.to.be.lt(ethers.parseEther('0.01') as unknown as number)
      })

      it('should disable interest', async () => {
        const foreignOmnibridge = contract as ForeignOmnibridge
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await generateInterest()
        await daiInterestImpl.payInterest(dai)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(foreignOmnibridge.connect(user).disableInterest(dai)).to.be.rejected
        await foreignOmnibridge.connect(owner).disableInterest(dai)
        await expect(foreignOmnibridge.interestImplementation(dai)).eventually.to.equal(setup.ZERO_ADDRESS)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('10'))
      })

      it('configuration', async () => {
        const foreignOmnibridge = contract as ForeignOmnibridge
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await expect(foreignOmnibridge.connect(user).setMinCashThreshold(dai, ethers.parseEther('2'))).to.be.rejected
        await foreignOmnibridge.connect(owner).setMinCashThreshold(dai, ethers.parseEther('2'))
        await expect(foreignOmnibridge.minCashThreshold(dai)).eventually.to.equal(ethers.parseEther('2'))
        await expect(daiInterestImpl.connect(user).setDust(dai, '1')).to.be.rejected
        await daiInterestImpl.connect(owner).setDust(dai, '1')
        const res0 = await daiInterestImpl.interestParams(dai)
        expect(res0.dust).to.equal(1n)
        await expect(daiInterestImpl.connect(user).setMinInterestPaid(dai, oneEther)).to.be.rejected
        await daiInterestImpl.connect(owner).setMinInterestPaid(dai, oneEther)
        const res1 = await daiInterestImpl.interestParams(dai)
        expect(res1.minInterestPaid).to.equal(oneEther)
        await expect(daiInterestImpl.connect(user).setInterestReceiver(dai, signers[1])).to.be.rejected
        await daiInterestImpl.connect(owner).setInterestReceiver(dai, signers[1])
        const res2 = await daiInterestImpl.interestParams(dai)
        expect(res2.interestReceiver).to.equal(signers[1])
        await expect(daiInterestImpl.connect(user).setMinAavePaid(oneEther)).to.be.rejected
        await daiInterestImpl.connect(owner).setMinAavePaid(oneEther)
        await expect(daiInterestImpl.minAavePaid()).eventually.to.equal(oneEther)
        await expect(daiInterestImpl.connect(user).setAaveReceiver(user)).to.be.rejected
        await daiInterestImpl.connect(owner).setAaveReceiver(user)
        await expect(daiInterestImpl.aaveReceiver()).eventually.to.equal(user)
      })

      it('should return invested tokens on withdrawal if needed', async () => {
        const foreignOmnibridge = contract as ForeignOmnibridge
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('9'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('10'))
        const data1 = contract.interface.encodeFunctionData('handleNativeTokens', [
          await dai.getAddress(),
          await user.getAddress(),
          ethers.parseEther('0.5'),
        ])
        await expect(executeMessageCall(exampleMessageId, data1)).eventually.to.equal(true)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('0.5'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('9.5'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('9'))
        const data2 = contract.interface.encodeFunctionData('handleNativeTokens', [
          await dai.getAddress(),
          await user.getAddress(),
          ethers.parseEther('2'),
        ])
        await expect(executeMessageCall(otherMessageId, data2)).eventually.to.equal(true)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('7.5'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('6.5'))
      })

      it('should allow to fix correct amount of tokens when aave is used', async () => {
        const foreignOmnibridge = contract as ForeignOmnibridge
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('9'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('10'))
        await dai.transfer(contract, ethers.parseEther('1'))
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('2'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('9'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('10'))
        await contract.connect(owner).fixMediatorBalance(dai, owner)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('2'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('9'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('11'))
      })

      it('should force disable interest implementation', async () => {
        const foreignOmnibridge = contract as ForeignOmnibridge
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await expect(dai.balanceOf(contract)).eventually.to.equal(ethers.parseEther('1'))
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('9'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('10'))
        await expect(daiInterestImpl.connect(user).forceDisable(dai)).to.be.rejected
        await daiInterestImpl.connect(owner).forceDisable(dai)
        await expect(dai.balanceOf(contract)).eventually.to.be.gt(ethers.parseEther('9.999') as unknown as number)
        await expect(daiInterestImpl.investedAmount(dai)).eventually.to.equal(ethers.parseEther('0'))
        await expect(contract.mediatorBalance(dai)).eventually.to.equal(ethers.parseEther('10'))
      })

      it('should allow to reinitialize when there are no invested funds', async () => {
        const foreignOmnibridge = contract as ForeignOmnibridge
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await generateInterest()
        await expect(daiInterestImpl.enableInterestToken(dai, oneEther, signers[2], ethers.parseEther('0.01'))).to.be.rejected
        await foreignOmnibridge.connect(owner).disableInterest(dai)
        await daiInterestImpl.connect(owner).enableInterestToken(dai, oneEther, signers[2], ethers.parseEther('0.01'))
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
      })

      it('should claim rewards', async () => {
        const foreignOmnibridge = contract as ForeignOmnibridge
        await aave.mint(ethers.parseEther('20000000'))
        await aave.transfer(incentivesController, ethers.parseEther('10000000'))
        await aave.approve(stkAAVE, ethers.parseEther('10000000'))
        await incentivesController.setDistributionEnd('1000000000000000000')
        await incentivesController.initialize(setup.ZERO_ADDRESS)
        await incentivesController.configureAssets([aDai], [oneEther])
        await foreignOmnibridge.initializeInterest(dai, daiInterestImpl, oneEther)
        await foreignOmnibridge.invest(dai)
        await generateInterest()
        await expect(daiInterestImpl.aaveAmount([aDai])).eventually.to.be.gt(ethers.parseEther('0.01') as unknown as number)
        await daiInterestImpl.claimAaveAndPay([aDai])
        await expect(aave.balanceOf(signers[2])).eventually.to.equal(0n)
        await expect(stkAAVE.balanceOf(signers[2])).eventually.to.be.gt(ethers.parseEther('0.01') as unknown as number)
        await expect(stkAAVE.stakersCooldowns(signers[2])).eventually.to.equal(0n)
        await expect(stkAAVE.connect(signers[2]).redeem(signers[2], ethers.parseEther('100000000'))).to.be.rejected
        await stkAAVE.connect(signers[2]).cooldown()
        await expect(stkAAVE.stakersCooldowns(signers[2])).eventually.to.be.gt(0)
        await expect(stkAAVE.connect(signers[2]).redeem(signers[2], ethers.parseEther('100000000'))).to.be.rejected
        // skip 11 days (COOLDOWN_SECONDS + UNSTAKE_WINDOW / 2)
        const block = await hre.ethers.provider.getBlock('latest') as ethers.Block
        const timestamp = block.timestamp
        await mineBlock(timestamp + (11 * 24 * 60 * 60))
        await stkAAVE.connect(signers[2]).redeem(signers[2], ethers.parseEther('100000000'))
        await expect(aave.balanceOf(signers[2])).eventually.to.be.gt(0)
        await expect(stkAAVE.balanceOf(signers[2])).eventually.to.equal(0n)
      })
    })
  }
}
describe('ForeignOmnibridge', () => {
  runTests(false)
})
describe('HomeOmnibridge', () => {
  runTests(true)
})
