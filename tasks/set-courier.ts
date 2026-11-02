import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

type Input = {
  address: string;
  router: string;
  add: boolean;
  remove: boolean;
}

task('set-courier', 'adds an address to, or removes it from, the router courier list')
  .addFlag('add', 'adds the given address to the courier list')
  .addFlag('remove', 'removes the given address from the courier list')
  .addParam('address', 'the address to add or remove from the courier list')
  .addParam('router', 'the router to operate on')
  .setAction(async (args: Input, hre: HardhatRuntimeEnvironment) => {
    const tokenOmnibridgeRouter = await hre.ethers.getContractAt('contracts/helpers/TokenOmnibridgeRouter.sol:TokenOmnibridgeRouter', args.router)
    let status: boolean | null = args.add === true ? true : null
    status = status || (args.remove === true ? false : null)
    if (status === null) throw new Error('no status change provided')
    const inputs = [args.address, status] as const
    const statusTx = await tokenOmnibridgeRouter.setCourierStatus(...inputs)
    console.log('tokenOmnibridgeRouter.setCourierStatus(%o, %o) => %o', ...inputs, statusTx.hash)
    await statusTx.wait()
  })
