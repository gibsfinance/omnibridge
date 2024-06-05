import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { WETHOmnibridgeRouter } from "../artifacts/types";

type Input = {
  owner: string;
  router: string;
}

task('transfer-ownership', 'runs the transfer ownership function on a router')
  .addParam('owner', 'sets the new owner')
  .addParam('router', 'the router to operate on')
  .setAction(async (args: Input, hre: HardhatRuntimeEnvironment) => {
    const wethOmnibridgeRouterV2 = await hre.ethers.getContractAt('contracts/helpers/WETHOmnibridgeRouterV2.sol:WETHOmnibridgeRouterV2', args.router) as unknown as WETHOmnibridgeRouter
    const [signer] = await hre.ethers.getSigners()
    if (await signer.getAddress() !== await wethOmnibridgeRouterV2.owner()) {
      console.log('%o is not %o', await signer.getAddress(), await wethOmnibridgeRouterV2.owner())
      throw new Error('owner does not match')
    }
    const inputs = [args.owner] as const
    const statusTx = await wethOmnibridgeRouterV2.transferOwnership(...inputs)
    console.log('wethOmnibridgeRouterV2.transferOwnership(%o, %o) => %o', ...inputs, statusTx.hash)
    await statusTx.wait()
  })
