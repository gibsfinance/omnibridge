import { task } from 'hardhat/config'
import type { HardhatRuntimeEnvironment } from 'hardhat/types'

type Input = {
  mediators: string
  wnative: string
  collector: string
  rescue: string
  skipVerify: boolean
}

/** The only chain this task may broadcast to: PulseChain testnet v4. Other chains need a new constant. */
const PULSECHAIN_TESTNET_V4 = 943n
/** The account the owner approved as fee collector, rescue recipient and deployer on the testnet. */
const APPROVED_TESTNET_ACCOUNT = '0xAF2ce0189f46f5663715b0b9ED2a10eA924AB9B0'
/** The v4 testnet erc20 home mediator, the one that delivers tokens bridged from Sepolia. */
const DEFAULT_MEDIATOR = '0x6B08a50865aDeCe6e3869D9AfbB316d0a0436B6c'
/** Wrapped PLS on the v4 testnet (`nativeAssetOut` of bridge-sdk). */
const DEFAULT_WNATIVE = '0x70499adEBB11Efd915E3b69E700c331778628707'

task('deploy-homefeeledger', 'deploys the home fee ledger on PulseChain testnet v4 (943)')
  .addOptionalParam('mediators', 'comma separated home mediators that may deliver and relay', DEFAULT_MEDIATOR)
  .addOptionalParam('wnative', 'the wrapped native token (WPLS)', DEFAULT_WNATIVE)
  .addOptionalParam('collector', 'the account credited with gibs fees. It cannot change', APPROVED_TESTNET_ACCOUNT)
  .addOptionalParam('rescue', 'the only account that receives rescued tokens. It cannot change', APPROVED_TESTNET_ACCOUNT)
  .addFlag('skipVerify', 'do not submit the source to the explorer')
  .setAction(async (args: Input, hre: HardhatRuntimeEnvironment) => {
    const { ethers } = hre
    const chainId = (await ethers.provider.getNetwork()).chainId
    if (chainId !== PULSECHAIN_TESTNET_V4) {
      throw new Error(`this task deploys to chain ${PULSECHAIN_TESTNET_V4}, the node reports chain ${chainId}`)
    }
    const mediators = args.mediators.split(',').map((mediator) => ethers.getAddress(mediator.trim()))
    const wnative = ethers.getAddress(args.wnative)
    const collector = ethers.getAddress(args.collector)
    const rescue = ethers.getAddress(args.rescue)
    if ([collector, rescue].includes(ethers.ZeroAddress)) throw new Error('an account is the zero address')
    for (const contract of [...mediators, wnative]) {
      if ((await ethers.provider.getCode(contract)) === '0x') throw new Error(`no code at ${contract}`)
    }

    const [signer] = await ethers.getSigners()
    const balance = await ethers.provider.getBalance(signer.address)
    console.log('deployer %o balance %o PLS', signer.address, ethers.formatEther(balance))

    const contractId = 'contracts/helpers/HomeFeeLedger.sol:HomeFeeLedger'
    const HomeFeeLedger = await ethers.getContractFactory(contractId)
    const inputs = [mediators, wnative, collector, rescue] as const
    const ledger = await HomeFeeLedger.deploy(...inputs)
    const transaction = ledger.deploymentTransaction()!
    console.log('deploy transaction %o', transaction.hash)
    const receipt = await transaction.wait()
    const address = await ledger.getAddress()
    console.log('home fee ledger: %o', address)
    console.log('block: %o gas used: %o', receipt!.blockNumber, receipt!.gasUsed)
    console.log('constructor mediators: %o', mediators)
    console.log('constructor wrappedNative: %o', wnative)
    console.log('constructor gibsCollector: %o', collector)
    console.log('constructor rescueRecipient: %o', rescue)
    if (args.skipVerify) return
    try {
      await hre.run('verify:verify', { address, contract: contractId, constructorArguments: inputs })
    } catch (error) {
      console.log('verification failed (the deploy itself succeeded): %o', (error as Error).message)
    }
  })
