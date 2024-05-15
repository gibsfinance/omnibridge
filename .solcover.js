const hre = require('hardhat')

module.exports = {
  mocha: {
    timeout: 30_000,
  },
  forceBackupServer: true,
  providerOptions: {
    port: 8545,
    seed: 'TestRPC is awesome!',
  },
  onServerReady: async () => {
    const abi = [{
      inputs: [{ name: "", type: "address"}],
      outputs: [{ name: "", type: "uint256" }],
      name: "balanceOf",
      stateMutability: "view",
      type: "function",
    }]
    const cDai = new hre.ethers.Contract('0x615cba17EE82De39162BB87dBA9BcfD6E8BcF298', abi)
    const signers = await hre.ethers.getSigners()
    const faucet = signers[6]
    while (true) {
      try {
        const balance = await cDai.balanceOf(faucet.getAddress())
        if (balance !== 0n) {
          break
        }
      } catch (e) {
        await new Promise(res => setTimeout(res, 1000))
      }
    }
  },
  skipFiles: ['mocks'],
}
