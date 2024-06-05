import { HardhatUserConfig } from 'hardhat/config'
import { HARDHAT_NETWORK_MNEMONIC } from 'hardhat/internal/core/config/default-config'
import 'solidity-coverage'
import 'hardhat-tracer'
import '@nomicfoundation/hardhat-toolbox'

import './tasks'

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
  sourcify: {
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
      ...(process.env.FORK ? {
        forking: {
          url: 'https://rpc-ethereum.g4mm4.io',
          blockNumber: 19_926_341,
        },
      } : {}),
    },
    localhardhat: {
      url: process.env.PROVIDER || 'http://localhost:8545',
    },
    mainnet: {
      accounts: {
        mnemonic: process.env.MNEMONIC || HARDHAT_NETWORK_MNEMONIC,
      },
      url: 'https://rpc-ethereum.g4mm4.io',
    },
    bsc: {
      accounts: {
        mnemonic: process.env.MNEMONIC || HARDHAT_NETWORK_MNEMONIC,
      },
      url: process.env.RPC_56 || 'https://binance.llamarpc.com',
    },
  },
  typechain: {
    outDir: 'artifacts/types',
    target: 'ethers-v6',
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || '',
      bsc: process.env.ETHERSCAN_API_KEY || '',
    },
  },
}

export default config
