import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

type Input = {
  bridge: string;
  wNative: string;
}

task('deploy-tokenomnibridgerouter', 'deploys the token omnibridge router')
  .addParam('wNative', 'the wNative contract to use to wrap (home) or unwrap (foreign)')
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
    const contractId = 'contracts/helpers/TokenOmnibridgeRouter.sol:TokenOmnibridgeRouter'
    const TokenOmnibridgeRouter = await hre.ethers.getContractFactory(contractId)
    const latest = await hre.ethers.provider.getBlock('latest')
    const eip1559Enabled = !!latest?.baseFeePerGas
    const inputs = [args.bridge, args.wNative, signer.address, eip1559Enabled] as const
    const tokenomnibridgerouter = await TokenOmnibridgeRouter.deploy(...inputs, {
      nonce: latestNonce,
      ...(eip1559Enabled ? {} : {
        type: 1,
      }),
    })
    console.log('new TokenOmnibridgeRouter(bridge=%o, wNative=%o, owner=%o, eip1559Enabled=%o) => %o', ...inputs, await tokenomnibridgerouter.getAddress())
    const tx = tokenomnibridgerouter.deploymentTransaction()!
    console.log('@%o', tx.hash)
    await tx.wait()
    if (hre.network.name !== 'hardhat') {
      await new Promise((resolve) => setTimeout(resolve, 30_000))
      await hre.run('verify:verify', {
        address: await tokenomnibridgerouter.getAddress(),
        contract: contractId,
        constructorArguments: inputs,
      })
    }
  })
