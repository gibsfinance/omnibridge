import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

type Input = {
  router: string
  token: string
  to: string
}

task('claim-tokens', 'claims tokens from the omnibridge')
  .addParam('token', 'the token to claim')
  .addParam('to', 'the address to send the tokens to')
  .addParam('router', 'the router contract to interact with')
  .setAction(async (args: Input, hre: HardhatRuntimeEnvironment) => {
    const [signer] = await hre.ethers.getSigners()
    console.log('signer: %o', signer.address)
    const router = await hre.ethers.getContractAt('BasicOmnibridge', args.router, signer)
    const tx = await router.claimTokens(args.token, args.to)
    console.log('tx: %o', tx.hash)
    const receipt = await tx.wait()
    console.log('receipt: %o', receipt!.hash)
  })
