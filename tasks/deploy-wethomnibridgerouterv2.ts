import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

type Input = {
  bridge: string;
  weth: string;
}

task('deploy-wethomnibridgerouterv2', 'deploys the weth omnibridge router')
  .addParam('weth', 'the weth contract to use to wrap (home) or unwrap (foreign)')
  .addParam('bridge', 'the bridge contract that should be used to bridge to (home) or receive from (foreign)')
  .setAction(async (args: Input, hre: HardhatRuntimeEnvironment) => {
    const [signer] = await hre.ethers.getSigners()
    console.log('deploying with %o@%o/%o', signer.address, await signer.getNonce('latest'), await signer.getNonce('pending'))
    if (hre.network.name !== 'hardhat') {
      for (const a of [args.bridge, args.weth]) {
        const code = await hre.ethers.provider.getCode(a)
        if (code === '0x') {
          console.log(`missing %o`, a)
          throw new Error('unable to deploy contract with missing dependencies')
        }
      }
    }
    const contractId = 'contracts/helpers/WETHOmnibridgeRouterV2.sol:WETHOmnibridgeRouterV2'
    const WETHOmnibridgeRouterV2 = await hre.ethers.getContractFactory(contractId)
    const inputs = [args.bridge, args.weth, signer.address] as const
    const latest = await hre.ethers.provider.getBlock('latest')
    const wethomnibridgerouterv2 = await WETHOmnibridgeRouterV2.deploy(...inputs, {
      maxFeePerGas: latest!.baseFeePerGas,
      maxPriorityFeePerGas: latest!.baseFeePerGas as bigint / 50n,
    })
    console.log('new WETHOmnibridgeRouterV2(%o, %o, %o) => %o', ...inputs, await wethomnibridgerouterv2.getAddress())
    const tx = wethomnibridgerouterv2.deploymentTransaction()!
    console.log('@%o', tx.hash)
    await tx.wait()
    await hre.run('verify:verify', {
      address: await wethomnibridgerouterv2.getAddress(),
      contract: contractId,
      constructorArguments: inputs,
    })
  })
