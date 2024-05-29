import { ZeroAddress, formatEther } from "ethers";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

type Input = {
  data: string;
}

task('parse-calldata', 'parses calldata to ensure that the appropriate parts will pass')
  .addParam('data', 'the calldata about to be signed over')
  .setAction(async (args: Input, hre: HardhatRuntimeEnvironment) => {
    const token = await hre.ethers.getContractAt('IERC677', ZeroAddress)
    const [to, amount, bytes] = token.interface.decodeFunctionData('transferAndCall', args.data)
    console.log('should be bridge on home %o', to)
    console.log('amount: %o or %o', amount, formatEther(amount))
    const router = bytes.slice(0, 42)
    console.log('should be router on foreign %o', router)
    const feeDirectorBytes = `0x${bytes.slice(42)}`
    const [[destination, fixedFee, limit, multiplier]] = hre.ethers.AbiCoder.defaultAbiCoder().decode(
      ['(address,bool,uint256,uint256)'],
      feeDirectorBytes,
    )
    console.log('destination %o', destination)
    console.log('fixed fee %o', fixedFee)
    console.log('limit %o or %o max', limit, formatEther(limit))
    console.log('multiplier %o or %o% of base fee', multiplier, formatEther(multiplier * 100n))
  })
