import chai from 'chai'
import * as ethers from 'ethers'
import { TypedContractEvent, TypedLogDescription } from '../../artifacts/types/common';
// geth && testrpc has different output of eth_sign than parity
// https://github.com/ethereumjs/testrpc/issues/243#issuecomment-326750236
export function normalizeSignature(rawSignature: string) {
    const signature = strip0x(rawSignature);
    // increase v by 27...
    return `0x${signature.slice(0, 128)}${(parseInt(signature.slice(128), 16) + 27).toString(16)}`;
}
// strips leading "0x" if present
export function strip0x(input: string) {
    return input.replace(/^0x/, '');
}
// extracts and returns the `v`, `r` and `s` values from a `signature`.
export function signatureToVRS(rawSignature: string) {
    chai.assert.equal(rawSignature.length, 2 + 32 * 2 + 32 * 2 + 2);
    const signature = strip0x(rawSignature);
    const v = signature.slice(64 * 2);
    const r = signature.slice(0, 32 * 2);
    const s = signature.slice(32 * 2, (32 * 2) + (32 * 2));
    return { v, r, s };
}
type Sig = {
    v: string;
    r: string;
    s: string;
}
export function packSignatures(array: Sig[]) {
    const length = strip0x(ethers.hexlify(array.length.toString(16)));
    const msgLength = length.length === 1 ? `0${length}` : length;
    let v = '';
    let r = '';
    let s = '';
    array.forEach((e) => {
        v = v.concat(e.v);
        r = r.concat(e.r);
        s = s.concat(e.s);
    });
    return `0x${msgLength}${v}${r}${s}`;
}
// returns BigNumber `num` converted to a little endian hex string
// that is exactly 32 bytes long.
// `num` must represent an unsigned integer
export function bigNumberToPaddedBytes32(num: bigint | number) {
    let result = strip0x(num.toString(16));
    while (result.length < 64) {
        result = `0${result}`;
    }
    return `0x${result}`;
}
// returns an promise that resolves to an object
// that maps `addresses` to their current balances
export async function getBalances(provider: ethers.Provider, addresses: string[]) {
    return await Promise.all(addresses.map((address) => {
        return provider.getBalance(address)
    })).then((balancesArray) => {
        const addressToBalance: Record<string, bigint> = {}
        addresses.forEach((address, index) => {
            addressToBalance[address] = balancesArray[index]
        })
        return addressToBalance
    })
}
// returns hex string of the bytes of the message
// composed from `recipient`, `value` and `transactionHash`
// that is relayed from `foreign` to `home` on withdraw
export function createMessage(rawRecipient: string, rawValue: number | bigint, rawTransactionHash: string, rawContractAddress: string) {
    const recipient = strip0x(rawRecipient);
    chai.assert.equal(recipient.length, 20 * 2);
    const value = strip0x(bigNumberToPaddedBytes32(rawValue));
    chai.assert.equal(value.length, 64);
    const transactionHash = strip0x(rawTransactionHash);
    chai.assert.equal(transactionHash.length, 32 * 2);
    const contractAddress = strip0x(rawContractAddress);
    chai.assert.equal(contractAddress.length, 20 * 2);
    const message = `0x${recipient}${value}${transactionHash}${contractAddress}`;
    const expectedMessageLength = (20 + 32 + 32 + 20) * 2 + 2;
    chai.assert.equal(message.length, expectedMessageLength);
    return message;
}
// returns array of integers progressing from `start` up to, but not including, `end`
export function range(start: number, end: number) {
    const result = [];
    for (let i = start; i < end; i++) {
        result.push(i);
    }
    return result;
}
// just used to signal/document that we're explicitely ignoring/expecting an error
export function ignoreExpectedError() { }

export const getEvents = async <T extends TypedContractEvent>(contract: ethers.BaseContract, filter: string, fromBlock = 0, toBlock = 'latest'): Promise<TypedLogDescription<T>[]> => {
    const evnts = await contract.queryFilter(filter, fromBlock, toBlock);
    return evnts.map((evnt) => {
        try {
            return contract.interface.parseLog(evnt);
        }
        catch (err) {
            return null;
        }
    }).filter((evnt): evnt is TypedLogDescription<T> => !!evnt)
}
export function expectEventInLogs(logs: ethers.LogDescription[], eventName: string, eventArgs = {}) {
    const events = logs.filter((e) => e.name === eventName);
    chai.expect(events.length > 0).to.equal(true, `There is no '${eventName}'`);
    const exception: Error[] = [];
    const event = events.find((e) => {
        for (const [k, v] of Object.entries(eventArgs)) {
            try {
                const r = e.fragment.inputs.reduce((res, input, i) => {
                    res[input.name] = e.args[i]
                    return res
                }, {} as Record<string, any>)
                contains(r, k, v);
            }
            catch (error) {
                exception.push(error as Error);
                return false;
            }
        }
        return true;
    });
    if (event === undefined) {
        throw exception[0];
    }
    return event;
}
export function contains(args: Record<string, unknown>, key: string, value: unknown) {
    chai.expect(key in args).to.equal(true, `Unknown event argument '${key}'`);
    if (value === null) {
        chai.expect(args[key]).to.equal(null);
    }
    else if (typeof args[key] === 'bigint') {
        chai.expect(args[key]).to.be.equal(value);
    }
}
