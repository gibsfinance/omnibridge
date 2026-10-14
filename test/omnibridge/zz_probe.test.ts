import hre from 'hardhat'
import * as ethers from 'ethers'
const MAIN = '0x4fD0aaa7506f3d9cB8274bdB946Ec42A1b8751Ef'
const WPLSB = '0x0e18d0d556b652794EF12Bf68B2dC857EF5f3996'
const WPLS = '0xA1077a294dDE1B09bB078844df40758a5D0f9a27'
const USDC = '0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07'
describe('probe', () => {
  it('probe', async function () {
    this.timeout(300000)
    await hre.network.provider.request({ method: 'hardhat_reset', params: [{ forking: { jsonRpcUrl: 'https://rpc.pulsechain.com', blockNumber: 27_540_000 } }] })
    const p = hre.ethers.provider
    const call = async (to: string, sig: string, args: any[] = []) => {
      const i = new ethers.Interface([`function ${sig}`])
      const name = sig.split('(')[0]
      try { const r = await p.call({ to, data: i.encodeFunctionData(name, args) }); return i.decodeFunctionResult(name, r).toString() } catch (e: any) { return 'ERR ' + (e.shortMessage||e.message).slice(0,100) }
    }
    for (const [label, m] of [['main', MAIN], ['wpls', WPLSB]]) {
      console.log(label, 'codesize', (await p.getCode(m)).length)
      for (const s of ['bridgeContract() returns (address)','owner() returns (address)','isTokenRegistered(address) returns (bool)','bridgedTokenAddress(address) returns (address)','nativeTokenAddress(address) returns (address)','minPerTx(address) returns (uint256)','maxPerTx(address) returns (uint256)','dailyLimit(address) returns (uint256)','executionMaxPerTx(address) returns (uint256)','getBridgeMode() returns (bytes4)','getBridgeInterfacesVersion() returns (uint64,uint64,uint64)','requestGasLimit() returns (uint256)','isInitialized() returns (bool)','mediatorContractOnOtherSide() returns (address)','totalSpentPerDay(address,uint256) returns (uint256)']) {
        const args = s.includes('(address)') ? [USDC] : s.includes('(address,uint256)') ? [USDC, 0] : []
        console.log(' ', s.split(' ')[0], await call(m, s, args))
      }
    }
    for (const t of [USDC, WPLS]) {
      console.log(t, await call(t,'symbol() returns (string)'), await call(t,'decimals() returns (uint8)'), await call(t,'totalSupply() returns (uint256)'), 'code', (await p.getCode(t)).length)
    }
    console.log('wpls registered main?', await call(MAIN,'isTokenRegistered(address) returns (bool)',[WPLS]), 'wpls bridge', await call(WPLSB,'isTokenRegistered(address) returns (bool)',[WPLS]))
    console.log('wpls bridge wnative-ish', await call(WPLSB,'WETH() returns (address)'), await call(WPLSB,'wNative() returns (address)'))
  })
})
