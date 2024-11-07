import { task } from 'hardhat/config'
import type { HardhatRuntimeEnvironment } from 'hardhat/types'

type Input = {
  bridge: string
  wNative: string
}

task('deploy-wplsomnibridgerouter', 'deploys the pls omnibridge router')
  .addParam('wNative', 'the wpls contract to use to wrap (home) or unwrap (foreign)')
  .addParam('bridge', 'the bridge contract that should be used to bridge to (home) or receive from (foreign)')
  .setAction(async (args: Input, hre: HardhatRuntimeEnvironment) => {
    const [signer] = await hre.ethers.getSigners()
    const latestNonce = await signer.getNonce('latest')
    console.log('deploying with %o@%o/%o', signer.address, latestNonce, await signer.getNonce('pending'))
    if (hre.network.name !== 'hardhat') {
      for (const a of [args.bridge, args.wNative]) {
        const code = await hre.ethers.provider.getCode(a)
        if (code === '0x') {
          console.log(`missing %o`, a)
          throw new Error('unable to deploy contract with missing dependencies')
        }
      }
    }
    const contractId = 'contracts/helpers/WPLSOmnibridgeRouter.sol:WPLSOmnibridgeRouter'
    const WPLSOmnibridgeRouter = await hre.ethers.getContractFactory(contractId)
    const inputs = [args.bridge, args.wNative, signer.address] as const
    // const latest = await hre.ethers.provider.getBlock('latest')
    const wplsOmnibridgeRouter = await WPLSOmnibridgeRouter.deploy(...inputs, {
      nonce: latestNonce,
    })
    console.log('new WPLSOmnibridgeRouter(%o, %o, %o) => %o', ...inputs, await wplsOmnibridgeRouter.getAddress())
    const tx = wplsOmnibridgeRouter.deploymentTransaction()!
    console.log('@%o', tx.hash)
    await tx.wait()
    await hre.run('verify:verify', {
      address: await wplsOmnibridgeRouter.getAddress(),
      contract: contractId,
      constructorArguments: inputs,
    })
  })
