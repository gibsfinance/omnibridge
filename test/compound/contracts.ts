import hre from 'hardhat'
export async function getCompoundContracts() {
    const comptroller = await hre.ethers.getContractAt('IHarnessComptroller', '0x85e855b22F01BdD33eE194490c7eB16b7EdaC019')
    const dai = await hre.ethers.getContractAt('IERC20', '0x0a4dBaF9656Fd88A32D087101Ee8bf399f4bd55f')
    const cDai = await hre.ethers.getContractAt('ICToken', '0x615cba17EE82De39162BB87dBA9BcfD6E8BcF298')
    const comp = await hre.ethers.getContractAt('IERC20', '0x6f51036Ec66B08cBFdb7Bd7Fb7F40b184482d724')
    return { comptroller, dai, cDai, comp }
}
