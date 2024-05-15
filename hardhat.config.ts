import { HardhatUserConfig } from 'hardhat/config'
import 'solidity-coverage'
import 'hardhat-tracer'
import '@nomicfoundation/hardhat-toolbox'

Error.stackTraceLimit = Infinity

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{
      version: '0.8.24',
    }],
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  tracer: {
    enabled: true,
  },
  networks: {
    hardhat: {
      accounts: {
        // this is the mnemonic used when the `--deterministic` flag is passed to ganache
        mnemonic: 'myth like bonus scare over problem client lizard pioneer submit female collect',
        accountsBalance: (10n ** 28n).toString(),
      },
      initialBaseFeePerGas: 0,
      chainId: 1337,
      enableTransientStorage: true,
      allowUnlimitedContractSize: true,
    },
    localhardhat: {
      url: process.env.PROVIDER || 'http://localhost:8545',
    },
  },
  typechain: {
    outDir: 'artifacts/types',
    target: 'ethers-v6',
  },
}

export default config
