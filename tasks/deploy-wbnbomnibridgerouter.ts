import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

type Input = {
  bridge: string;
  wNative: string;
}

task('deploy-wbnbomnibridgerouter', 'deploys the bnb omnibridge router')
  .addParam('wNative', 'the wbnb contract to use to wrap (home) or unwrap (foreign)')
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
    const contractId = 'contracts/helpers/WBNBOmnibridgeRouter.sol:WBNBOmnibridgeRouter'
    const WBNBOmnibridgeRouter = await hre.ethers.getContractFactory(contractId)
    const inputs = [args.bridge, args.wNative, signer.address] as const
    // const latest = await hre.ethers.provider.getBlock('latest')
    const wbnbomnibridgerouter = await WBNBOmnibridgeRouter.deploy(...inputs, {
      nonce: latestNonce,
    })
    console.log('new WBNBOmnibridgeRouter(%o, %o, %o) => %o', ...inputs, await wbnbomnibridgerouter.getAddress())
    const tx = wbnbomnibridgerouter.deploymentTransaction()!
    console.log('@%o', tx.hash)
    await tx.wait()
    await hre.run('verify:verify', {
      address: await wbnbomnibridgerouter.getAddress(),
      contract: contractId,
      constructorArguments: inputs,
    })
  })
