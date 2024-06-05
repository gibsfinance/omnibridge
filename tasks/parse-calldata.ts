import { ZeroAddress, formatEther } from "ethers";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

type Input = {
  data: string;
}

task('parse-calldata', 'parses calldata to ensure that the appropriate parts will pass')
  .addParam('data', 'the calldata about to be signed over')
  .setAction(async (args: Input, hre: HardhatRuntimeEnvironment) => {
    if (args.data.slice(0, 10) === '0x867f7a4d') {
      // amb message
      const bridge = await hre.ethers.getContractAt('BasicOmnibridge', ZeroAddress)
      const [token, pitstop, amount, calldata] = bridge.interface.decodeFunctionData('handleNativeTokensAndCall', args.data)
      console.log('token %o', token)
      console.log('pitstop %o', pitstop)
      console.log('amount %o', amount)
      // const omnibridge = await hre.ethers.getContractAt('WETHOmnibridgeRouterV2', ZeroAddress)
      // const parsed = omnibridge.interface.decodeFunctionData('onTokenBridged', calldata)
      const [[destination, fixedFee, limit, multiplier]] = hre.ethers.AbiCoder.defaultAbiCoder().decode(
        ['(address,bool,uint256,uint256)'],
        calldata,
      )
      console.log('destination %o', destination)
      console.log('fixed fee %o', fixedFee)
      console.log('limit %o or %o max', limit, formatEther(limit))
      console.log('multiplier %o or %o% of base fee', multiplier, formatEther(multiplier * 100n))
      return
    }
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
