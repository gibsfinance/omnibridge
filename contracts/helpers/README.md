# Omnibridge helpers contracts

## WETHOmnibridgeRouter

This contract allows reducing the number of actions required for native-to-erc20 bridging over Omnibridge.
An example of such bridging scenarios might be:
* Bridging ETH from Mainnet to the xDAI chain in a form of [WETH on xDAI](https://blockscout.com/poa/xdai/tokens/0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1/token-transfers)
* Bridging BNB from BSC to the xDAI chain in a form of [WBNB on xDAI](https://blockscout.com/poa/xdai/tokens/0xCa8d20f3e0144a72C6B5d576e9Bd3Fd8557E2B04/token-transfers)

Helper supports full-duplex bridging operations.
Thus, there are 2 main usage scenarios for the helper contract.

Even though the below examples are given for the BNB native coin from the BSC,
the mechanism works exactly the same for other native coins as well. 

### BNB => WBNB => WBNB on xDAI

In order to wrap native coins and bridge them through the Omnibridge to the other chain, make the following transaction:
* Call `Helper.wrapAndRelayTokens()`/`Helper.wrapAndRelayTokens(receiver)` in BSC
  
Desired bridged amount of BNB should be send as the transaction value argument.
If the given amount of BNB cannot be bridged immediately, the whole transaction will revert.

The upper call is identical to the following 3 sequential transactions:
* Call `WBNB.deposit()` in BSC
* Call `WBNB.approve(Omnibridge, value)` in BSC
* Call `Omnibridge.relayTokens(WBNB, value)` in BSC

### WBNB on xDAI => WBNB => BNB 

In order to bridged wrapped tokens back to the origin chain through the Omnibridge and automatically withdraw them, make the following transaction:
* Call `WBNB_on_xDAI.transferAndCall(Omnibridge, value, Helper ++ receiver)` in xDAI

Alternatively, make the following 2 transactions:
* Call `WBNB_on_xDAI.approve(Omnibridge, value)` in xDAI
* Call `Omnibridge.relayTokensAndCall(WBNB_on_xDAI, Helper, value, receiver)` in xDAI

It is crucially important to correctly specify the receiver in the upper approaches.
This should be an address of the final BNB receiver in BSC.
Always include it explicitly in the call, even if msg.sender is equal to the receiver.

The upper calls are identical to the following 3 sequential transactions:
* Call `WBNB_on_xDAI.approve(Omnibridge, value)` in xDAI
* Call `Omnibridge.relayTokens(WBNB_on_xDAI, value)` in xDAI
* Call `WBNB.withdraw(value - fee)` in BSC

## HomeFeeLedger

`HomeFeeLedger` collects every bridge fee on the home side (PulseChain) in a ledger.
It never replaces or changes the existing routers.
A fee is a gibs fee plus an optional partner fee. The partner fee is added to the gibs fee.

### Fees and limits

* The gibs rate is set by the admin. It can never be above `MAXIMUM_GIBS_RATE` (100 basis points, 1%).
* A partner registers freely with `registerPartner(payout, rate)`. Ids start at 1. Id 0 means no partner.
* A partner rate can never be above `MAXIMUM_PARTNER_RATE` (100 basis points).
* The caller of a transfer states `maximumTotalRate`. Outbound transfers revert above it.
  Inbound transfers charge only up to it, and cut the partner fee first, then the gibs fee.
* The mediator list, `wNative` and `gibsCollector` are fixed at construction.
* The admin can set the gibs rate and rescue unaccounted tokens. Nothing else.
  The admin cannot touch the ledger, the collector, the mediators or any partner.

### Home to foreign

Call `relay(mediator, token, amount, receiver, data, partnerId, maximumTotalRate)` after you approve the token.
For native PLS call `relayNative(mediator, receiver, data, partnerId, maximumTotalRate)` with a value.
The contract measures what it receives (fee-on-transfer tokens are safe), credits the fees,
and calls `relayTokensAndCall(token, receiver, rest, data)` on the mediator.
`data` is passed unchanged, so it can carry the `FeeDirector` of the existing routers.
The existing mediators keep their own fee as well (0.3% on the PulseChain mediators when this was written).

### Foreign to home

Send the tokens with `relayTokensAndCall` to the ledger address on the foreign chain.
Set `data` to `abi.encode(address recipient, uint256 partnerId, uint16 maximumTotalRate, bool unwrap)` (128 bytes).
The mediator transfers the tokens, then calls `onTokenBridged` and ignores a failure.
So after its caller check, `onTokenBridged` never reverts:

* It uses the smaller of `value` and the balance that is not owed to anyone.
* Malformed data, a zero recipient or nothing available leaves the tokens outside the ledger (`Skipped` is emitted).
  The admin can move them with `rescueUnaccounted`.
* If the payment to the recipient fails, the recipient is credited in the ledger.
  When `unwrap` fails, the recipient is credited WPLS, not PLS.

### Withdrawing

`withdraw(token)` and `withdrawTo(token, to)` pay the caller's balance. The zero address as token means native coin.
`owed[token][account]` is the balance and `totalOwed[token]` is the sum.
