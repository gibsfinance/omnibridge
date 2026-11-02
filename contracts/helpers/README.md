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

## TokenOmnibridgeRouter: operating rules

These rules are for the delivery service, relayers, and the bridge interface.
They describe what the router on the foreign side (Ethereum, Binance Smart Chain) does today.

### One entry for every delivery

Call `safeExecuteSignaturesWithAutoGasLimit(runner, message, signatures)` on the router.
The router picks the path:

* A message the bridge has not relayed yet is a fresh delivery. The router passes it to the bridge.
  The named `runner` must be a validator, or the call reverts `RunnerNotValidator(runner)`.
* A message the bridge already relayed, but whose tokens stranded in the router, is a recovery.
  Anyone may name any runner. Only a runner that is a validator earns the tip.

The caller does not have to be the runner. The tip goes to the runner.
The tip is bound to the message the call handles. It is paid only on that message's own fresh delivery or recovery.
A call to `recover(message, signatures)` never pays a tip.

### Simulate first and read the outcome

Relayers should simulate every call (`eth_call`) before they send it.
Both the entry and `recover` return a `DeliveryOutcome`:

* `Delivered` (0): the entry relayed a fresh message through the bridge.
* `Recovered` (1): the message had stranded in the router and the call paid it.
* `AlreadyHandled` (2): the router already paid this message. Another relayer won the race.

Losing a race is not an error. The call returns `AlreadyHandled` at once and writes nothing.
In the unit test fixture a losing call costs about 37,000 gas, transaction cost included.
Before this change it reverted and cost 112,649 gas on the entry and 76,682 gas on `recover`.

Every genuine fault still reverts: bad signatures, wrong executor, a message for another recipient,
a message the bridge never relayed, a message that failed and was refunded, an unknown bridged token,
and a runner that is not a validator on a fresh delivery.

### Gas for a fresh delivery

The real bridge forwards almost all the gas it has to the mediator. So on mainnet the transaction gas is the number that matters, not the gas in the message header.
On a mainnet fork, a fresh wrapped ether delivery with an unwrap and a fixed tip needed at least 444,000 transaction gas through the entry.
The same kind of message sent straight to the bridge needed 366,000.
Below that the whole transaction ran out of gas and reverted. No gas level left the tokens stranded.
Use the simulation to set the gas. Do not reuse a limit sized for a direct bridge call.

### When the entry reverts `DeliveryNotCompleted`

A fresh delivery to this router through the entry is all or nothing.
When the router's callback fails, the entry reverts `DeliveryNotCompleted(messageId)`.
The tokens stay with the mediator and the message stays unrelayed.

This happens when the callback fails for a reason other than gas, for example data the router cannot read.
The delivery service then relays the message directly on the Arbitrary Message Bridge
(`safeExecuteSignaturesWithAutoGasLimit(message, signatures)` on the bridge, not on the router).
The bridge records success, but the tokens strand in the router.
Recovery fails for the same reason the callback failed, so only the owner can release them with `claimTokens`.

### Combinations the interface must refuse

Each of these strands the tokens in the router for good. Recovery refuses them.
Only the owner's `claimTokens` can release them.

* A message through a mediator that is not this router's own mediator.
  The router accepts callbacks only from its mediator, and recovery reverts `WrongExecutor`.
* A plain transfer to the router with no data (`relayTokens` instead of `relayTokensAndCall`).
  The mediator sends the tokens but never calls the router, and recovery reverts `UnsupportedSelector`.
* PulseChain's copy of WETH (it has the same address as WETH on Ethereum) with the 20-byte legacy data form (a bare recipient address).
  The mediator delivers its bridged copy, not real WETH, and the legacy form only unwraps real WETH.
  The router reverts `LegacyFormRequiresWrappedNative(token)`.
  Use the fee director data form instead. It pays the bridged copy as a token, never as ether.

### Validator rotation

Recovery checks the signatures against the validator set that is live when recovery runs.
When validators rotate, a strand signed only by validators that left can no longer be recovered.
Only the owner's `claimTokens` can release it. Recover strands soon after they happen.

### Recipients that need much gas to receive ether

An unwrap pays ether with at most 50,000 gas for the recipient (plus the 2,300 stipend).
A recipient that refuses ether, or needs more gas to receive it, gets wrapped ether instead.
A Safe 1.3.0 wallet needs about 6,700 gas, so ordinary smart contract wallets receive ether.

### Fee-on-transfer tokens

The router never refuses a fee-on-transfer token (a token that takes a cut on each transfer).
Every delivery, fresh or recovered, pays what the message names, capped at what the router holds of that token when the payment runs.
The message is then closed.

The router keeps every stranded delivery of a token in one balance.
So a delivery whose own tokens arrived short can draw on another stranded delivery of the same token,
and a later message can find less than it names and be paid the smaller amount.
The owner's `claimTokens` is the rescue path. The owner uses it to make any good-faith user left short whole.
