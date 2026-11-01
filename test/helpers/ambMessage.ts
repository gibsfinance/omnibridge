import * as ethers from 'ethers'

const coder = ethers.AbiCoder.defaultAbiCoder()

/** Builds a message in the Arbitrary Message Bridge layout. */
export const buildMessage = (options: { messageId: string; executor: string; innerCall: string; sender: string; gas?: bigint }) =>
    ethers.concat([
        options.messageId,
        options.sender,
        options.executor,
        ethers.toBeHex(options.gas ?? 2_000_000n, 4),
        '0x02', // source chain id length
        '0x01', // destination chain id length
        '0x00', // data type
        '0x0171', // source chain id: 369
        '0x01', // destination chain id: 1
        options.innerCall,
    ])

/** Encodes handleNativeTokensAndCall(token, recipient, value, feeDirectorBytes). */
export const handleNativeCall = (options: { token: string; recipient: string; value: bigint; data: string }) =>
    ethers.concat([
        ethers.id('handleNativeTokensAndCall(address,address,uint256,bytes)').slice(0, 10),
        coder.encode(['address', 'address', 'uint256', 'bytes'], [options.token, options.recipient, options.value, options.data]),
    ])

/**
 * Packs signatures in the bridge blob layout: one count byte, the v bytes, the r words, the s words.
 * The shared helpers.packSignatures cannot be used: it throws for counts below ten.
 */
export const packSignatures = (pieces: Array<{ v: string; r: string; s: string }>) =>
    '0x' +
    pieces.length.toString(16).padStart(2, '0') +
    pieces.map((piece) => piece.v).join('') +
    pieces.map((piece) => piece.r).join('') +
    pieces.map((piece) => piece.s).join('')
