import hre from 'hardhat'
import '../setup'
import * as chai from 'chai'
import { TokenReaderTest } from '../../artifacts/types'

describe('TokenReader Library', () => {
    describe('test different possible tokens', () => {
        const setupContract = async () => {
            const TokenReaderTest = await hre.ethers.getContractFactory('TokenReaderTest')
            return await TokenReaderTest.deploy()
        }
        let test!: TokenReaderTest

        before(async () => {
            test = await setupContract()
        })
        for (let i = 1; i <= 8; i++) {
            it(`should handle Token${i}`, async () => {
                await chai.expect(test.getFunction(`test${i}`)()).to.be.fulfilled
            })
        }
    })
})
