import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

type Input = {
  address: string;
  router: string;
  add: boolean;
  remove: boolean;
}

task('set-validator', 'sets the status of an address on the contract')
  .addFlag('add', 'adds the given address to the validator set')
  .addFlag('remove', 'removes the given address from the validator set')
  .addParam('address', 'the address to add or remove from the validator set')
  .addParam('router', 'the router to operate on')
  .setAction(async (args: Input, hre: HardhatRuntimeEnvironment) => {
    const tokenOmnibridgeRouter = await hre.ethers.getContractAt('contracts/helpers/TokenOmnibridgeRouter.sol:TokenOmnibridgeRouter', args.router)
    let status: boolean | null = args.add === true ? true : null
    status = status || (args.remove === true ? false : null)
    if (status === null) throw new Error('no status change provided')
    const inputs = [args.address, status] as const
    const statusTx = await tokenOmnibridgeRouter.setValidatorStatus(...inputs)
    console.log('tokenOmnibridgeRouter.setValidatorStatus(%o, %o) => %o', ...inputs, statusTx.hash)
    await statusTx.wait()
  })
