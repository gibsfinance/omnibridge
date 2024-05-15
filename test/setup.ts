import { ethers } from 'ethers'
import hre from 'hardhat'

export const ERROR_MSG = 'VM Exception while processing transaction: revert'
export const ERROR_MSG_OPCODE = 'VM Exception while processing transaction: invalid opcode'
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const F_ADDRESS = '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF'
export const INVALID_ARGUMENTS = 'Invalid number of arguments to Solidity function'

export const requirePrecompiled = async <T extends ethers.ContractFactory>(path: string): Promise<T> => {
    const artifact = await import(`${`../precompiled/${path}`}`)
    const [deployer] = await hre.ethers.getSigners()
    const factory = new hre.ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer)
    return factory as T
}
