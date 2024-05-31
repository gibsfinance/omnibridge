import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as helpers from '@nomicfoundation/hardhat-network-helpers'
import type { WETH, WETHOmnibridgeRouterV2 } from "../artifacts/types";

type Input = {
  router: string;
  data?: string;
}

task('check-on-token-bridge', 'checks that the onTokenBridged call works when impersonating the bridge')
  .addParam('router', 'the router contract to interact with')
  .addOptionalParam('data', 'optional calldata')
  .setAction(async (a: Input, hre: HardhatRuntimeEnvironment) => {
    const [signer] = await hre.ethers.getSigners()
    const router = await hre.ethers.getContractAt('WETHOmnibridgeRouterV2', a.router)
    const bridge = await router.bridge()
    const weth = await hre.ethers.getContractAt('WETH', await router.WETH())
    console.log({
      bridge, weth: await weth.getAddress(),
    })
    const oneEther = 10n ** 18n
    const funder = await hre.ethers.getImpersonatedSigner('0x9Cd83BE15a79646A3D22B81fc8dDf7B7240a62cB')
    const funderWeth = weth.connect(funder) as WETH
    const depositTx = await funderWeth.deposit({
      value: oneEther,
    })
    await depositTx.wait()
    const transferTx = await funderWeth.transfer(router, oneEther)
    await transferTx.wait()
    await helpers.stopImpersonatingAccount(await funder.getAddress())
    const encodedFeeDirector = a.data || hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'bool', 'uint256', 'uint256'],
      [signer.address, false, oneEther / 10n, oneEther / 10n],
    )
    console.log('encodedFeeDirector', encodedFeeDirector)
    // for some reason we have to provide an impersonated signer to run a view method
    const bridgeSigner = await hre.ethers.getImpersonatedSigner(bridge)
    const routerWithBridgeSigner = router.connect(bridgeSigner) as WETHOmnibridgeRouterV2
    await routerWithBridgeSigner.onTokenBridged.staticCall(weth, oneEther, encodedFeeDirector, {
      from: bridge,
    })
  })
