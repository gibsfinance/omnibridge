import { task } from 'hardhat/config'
import type { HardhatRuntimeEnvironment } from 'hardhat/types'
import { APPROVED_ACCOUNT, resolveDeployPlan, type DeployTaskArguments } from './homefeeledger-deploy-plan'

type Input = DeployTaskArguments & {
  skipVerify: boolean
  allowMainnet: boolean
}

task(
  'deploy-homefeeledger',
  'deploys the home fee ledger on PulseChain testnet v4 (943), or PulseChain mainnet (369) with --allow-mainnet',
)
  .addOptionalParam('mediators', 'comma separated home mediators that may deliver and relay. Defaults depend on the chain')
  .addOptionalParam('wnative', 'the wrapped native token (WPLS). Defaults depend on the chain')
  .addOptionalParam('collector', 'the account credited with gibs fees. It cannot change. Defaults depend on the chain')
  .addOptionalParam('rescue', 'the only account that receives rescued tokens. It cannot change. Defaults depend on the chain')
  .addFlag('skipVerify', 'do not submit the source to the explorer')
  .addFlag('allowMainnet', 'required to deploy to PulseChain mainnet (369). Refused on any other chain')
  .setAction(async (args: Input, hre: HardhatRuntimeEnvironment) => {
    const { ethers } = hre
    const chainId = (await ethers.provider.getNetwork()).chainId
    // resolves and checks every argument before anything is read from the node or sent
    const plan = resolveDeployPlan({ chainId, allowMainnet: args.allowMainnet, taskArguments: args })
    for (const contract of [...plan.mediators, plan.wrappedNative]) {
      if ((await ethers.provider.getCode(contract)) === '0x') throw new Error(`no code at ${contract}`)
    }

    const [signer] = await ethers.getSigners()
    // A missing key falls back to the public test phrase, whose accounts anyone can drain. Refuse any
    // deployer other than the approved account before anything is sent.
    if (signer.address !== APPROVED_ACCOUNT) {
      throw new Error(`deployer ${signer.address} is not the approved account ${APPROVED_ACCOUNT}`)
    }
    const balance = await ethers.provider.getBalance(signer.address)
    console.log('network %o chain %o', plan.networkName, plan.chainId)
    console.log('deployer %o balance %o PLS', signer.address, ethers.formatEther(balance))

    const contractId = 'contracts/helpers/HomeFeeLedger.sol:HomeFeeLedger'
    const HomeFeeLedger = await ethers.getContractFactory(contractId)
    const inputs = [plan.mediators, plan.wrappedNative, plan.gibsCollector, plan.rescueRecipient] as const
    const ledger = await HomeFeeLedger.deploy(...inputs)
    const transaction = ledger.deploymentTransaction()!
    console.log('deploy transaction %o', transaction.hash)
    const receipt = await transaction.wait()
    const address = await ledger.getAddress()
    console.log('home fee ledger: %o', address)
    console.log('block: %o gas used: %o', receipt!.blockNumber, receipt!.gasUsed)
    console.log('constructor mediators: %o', plan.mediators)
    console.log('constructor wrappedNative: %o', plan.wrappedNative)
    console.log('constructor gibsCollector: %o', plan.gibsCollector)
    console.log('constructor rescueRecipient: %o', plan.rescueRecipient)
    if (args.skipVerify) return
    try {
      await hre.run('verify:verify', { address, contract: contractId, constructorArguments: inputs })
    } catch (error) {
      console.log('verification failed (the deploy itself succeeded): %o', (error as Error).message)
    }
  })
