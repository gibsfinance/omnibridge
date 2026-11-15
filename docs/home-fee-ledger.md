# Earn a fee on bridges you send: HomeFeeLedger

Status: not deployed. 2026-11-13.

This guide is for a wallet, an app or any other partner that sends users across the gibs bridge. It explains how a fee is set and paid. The contract is `contracts/helpers/HomeFeeLedger.sol`. It runs on the home side of the bridge, which is PulseChain.

The contract is unaudited and has no deployed address yet.

## How it works, in short

- There is no admin and no registry. Nothing in the contract can be set after construction.
- The sender of each transfer writes the fee into the transfer data. The data names the gibs fee rate, an optional partner account and the partner fee rate.
- The ledger takes the gibs fee and the partner fee from the transfer, then bridges or pays out the rest.
- The ledger never sends a fee out at once. It credits the fee to the fee collector and to the partner account.
- Each account withdraws its own balance, one token at a time.

## Terms

| Term | Meaning |
|---|---|
| Home side | PulseChain. The ledger lives here. |
| Foreign side | The other chain of a bridge, for example Ethereum. |
| Mediator | A bridge contract on the home side. The ledger works only with mediators that its constructor allowed. |
| Gibs fee | The fee that goes to one fixed account, `gibsCollector`. |
| Partner fee | The fee that goes to the `partner` account named in the data. It is added on top of the gibs fee. |
| Rate | A share written as 1e18 fixed point. 1e18 is 100 percent. 1e16 is 1 percent. 5e15 is 0.5 percent. 2.5e15 is 0.25 percent. |
| Ledger | The `owed` table. It records what each account can withdraw, per token. |

## Fee rules and limits

A fee is `amount * rate / 1e18`, rounded down. The gibs fee and the partner fee are each rounded down on their own, so the rounding dust goes to the recipient.

| Rate | Who writes it | Limit |
|---|---|---|
| `feeRateE18` (gibs fee) | The sender of the transfer | Taken as written |
| `partnerRateE18` | The sender of the transfer | Taken as written |

The only limit is on the sum. `feeRateE18 + partnerRateE18` must be at most 1e18 (100 percent), because the fees cannot be larger than what arrived. A partner rate above zero needs a non-zero `partner`.

The multiplication uses `Math.mulDiv`, which is exact for any 256 bit input. Each rate is at most 1e18 and the two fees together are at most the amount, so the result always fits.

The bridge mediators keep their own fee as well. That fee is separate from the ledger. On the PulseChain fork that the tests use (block 27,540,000), the main mediator and the WPLS bridge mediator kept 0.3 percent on a home to foreign transfer.

## Who can set a fee on whose tokens

Only the sender of a crossing writes its data. The data travels with that crossing only. The ledger reads it only when a listed mediator delivers tokens and calls `onTokenBridged`. Nobody can change the fee on tokens that another sender sends. Anyone can encode any data for their own crossing, including a fee of zero.

## Constructor

```solidity
constructor(address[] mediators, address wNative, address gibsCollector, address rescueRecipient)
```

All four are fixed for good. The call reverts with `NoMediators` for an empty list and with `ZeroAddress` for a zero address.

## Outbound: send from PulseChain

Your interface calls the ledger instead of the mediator.

```solidity
struct FeeTerms {
    uint256 feeRateE18;
    address partner;
    uint256 partnerRateE18;
}

function relay(address mediator, address token, uint256 amount, address receiver, bytes calldata data, FeeTerms calldata terms) external
function relayNative(address mediator, address receiver, bytes calldata data, FeeTerms calldata terms) external payable
```

For `relay`, the user first approves the ledger for `amount` of `token`. For `relayNative`, the user sends PLS as the transaction value. The ledger wraps it into WPLS.

The ledger then does this, in order:

1. It checks that `mediator` is on the allowed list. If not, it reverts with `NotMediator`.
2. It pulls the tokens and measures what arrived. A token that charges a fee on transfer is safe, because the ledger counts only what it received.
3. It checks the terms. Fees that add up to more than 100 percent, or a partner rate with no partner, revert with `InvalidFees`.
4. It credits the gibs fee to `gibsCollector` and the partner fee to `partner`.
5. It calls `relayTokensAndCall(token, receiver, rest, data)` on the mediator. It passes `data` unchanged and never reads it.
6. It emits `Relayed`.

If any step fails, the whole transaction reverts. If nothing arrives, or nothing is left after the fees, the call reverts with `NothingReceived`.

## Inbound: send to PulseChain

A transfer from the foreign side pays a fee only when it is sent to the ledger. On the foreign chain, your interface calls `relayTokensAndCall` on the foreign mediator. It sets the receiver to the ledger address on PulseChain. It sets `data`, the last parameter, to exactly this encoding:

```solidity
abi.encode(address recipient, bool unwrap, uint256 feeRateE18, address partner, uint256 partnerRateE18)
```

The encoding is 160 bytes: five 32-byte words. Set `unwrap` to `true` to pay WPLS out as native PLS. It has no effect for any other token. Set `partner` to the zero address and `partnerRateE18` to 0 for no partner. A partner that equals the recipient is allowed. The recipient then gets the partner fee back in the ledger.

On PulseChain, the mediator delivers the tokens to the ledger. Then it calls this function on the ledger:

```solidity
function onTokenBridged(address token, uint256 value, bytes calldata data) external
```

Only an allowed mediator can call it. Any other caller gets `NotMediator`.

### The inbound path never reverts

The mediator ignores a failed callback. If `onTokenBridged` reverted, the tokens would sit in the ledger with no owner. So after the caller check, the function never reverts on purpose. Instead, it handles each problem like this:

| Problem | What happens | Event |
|---|---|---|
| `data` is not exactly 160 bytes, or an address or bool word holds bits that its type cannot hold | Nothing is paid. The tokens stay outside the ledger. | `Skipped` with reason `MalformedData` |
| The fees add up to more than 100 percent, or the partner rate is above zero with no partner | Same as above. | `Skipped` with reason `MalformedData` |
| The recipient is the zero address | Same as above. | `Skipped` with reason `ZeroRecipient` |
| No free balance is available | Same as above. | `Skipped` with reason `NothingAvailable` |
| A second delivery starts while one is running | Same as above. | `Skipped` with reason `Reentrant` |
| The payment to the recipient fails, for any reason | The ledger credits the rest to the recipient instead. The recipient withdraws it later. | `Credited` with reason `FailedPayout` |
| The native PLS payment fails after the unwrap | The ledger wraps the PLS again and credits WPLS, not PLS. | `Credited` with reason `FailedPayout` |

The ledger never pays out more than it received. It uses the smaller of two numbers: the `value` that the mediator reports, and the balance that the ledger owes to nobody.

An instruction that is not valid is not charged a fee of any kind. The tokens wait outside the ledger. Anyone can send them to the fixed `rescueRecipient` with `rescueUnaccounted(token)`. No key chooses the destination.

"Never reverts" covers the contract's own logic. It cannot cover running out of gas. If the callback runs out of gas, its changes are undone and the tokens stay outside the ledger. No `Skipped` event is emitted in that case.

## Withdraw

```solidity
function withdraw(address token) external
function withdrawTo(address token, address to) external
```

- Call these from the account that earned the credit. They pay the caller's whole balance of `token`.
- `withdrawTo` sends the balance to another account. It refuses the zero address.
- With nothing owed, the call reverts with `NothingToPay`.
- Fees are in the token that was bridged. Fees from `relayNative` and from WPLS deliveries are credited in WPLS, not PLS.

Read a balance with `owed(address token, address account)`. Read the sum of all balances of one token with `totalOwed(address token)`. The zero address as `token` means native PLS. No code path credits native PLS today.

## Events to watch

| Event | When |
|---|---|
| `Credited(address indexed token, address indexed account, uint256 amount, CreditReason reason)` | The ledger credits an account. `reason` is `GibsFee` (0), `PartnerFee` (1) or `FailedPayout` (2). |
| `Withdrawn(address indexed token, address indexed account, address indexed to, uint256 amount)` | An account withdraws. |
| `Relayed(address indexed mediator, address indexed token, address indexed sender, address receiver, uint256 received, uint256 sent, address partner)` | An outbound transfer reaches the mediator. |
| `Delivered(address indexed mediator, address indexed token, address indexed recipient, uint256 value, uint256 available, uint256 paid, address partner)` | An inbound transfer is split and paid. |
| `Skipped(address indexed mediator, address indexed token, uint256 value, SkipReason reason)` | An inbound transfer stays outside the ledger. `reason` is `MalformedData` (0), `ZeroRecipient` (1), `NothingAvailable` (2) or `Reentrant` (3). |
| `Rescued(address indexed token, address indexed to, uint256 amount)` | Tokens that were outside the ledger go to `rescueRecipient`. |
| `MediatorAllowed(address indexed mediator)` | Once per mediator, at deployment. |

To total your partner fees, sum `Credited` events where `account` is your partner account and `reason` is `PartnerFee`. `Delivered.paid` is the amount meant for the recipient, even when the payment failed.

## What nobody can do

There is no admin. No function sets a rate, a partner, the collector, the rescue recipient, the wrapped token or the mediator list. The contract has no pause and no upgrade path. Anyone can call `rescueUnaccounted(address token)`. It sends the part of the balance that is not owed to anyone to `rescueRecipient` and never touches `totalOwed`.

## Known limits and open items

- **Not deployed and not audited.** The task `tasks/deploy-homefeeledger.ts` deploys to PulseChain testnet v4 only.
- **Token payout gas is not capped.** On the inbound path, the payment to the recipient gives the token contract all the remaining gas. A native PLS payment is capped at `NATIVE_PAYOUT_GAS`, 100,000 gas. A token that burns all the gas can make the callback run out of gas. Then the delivery stays outside the ledger until someone calls `rescueUnaccounted`.
- **Inbound tests use a stand-in for the bridge.** The fork test calls `onTokenBridged` from the real mediator address, but no real bridge message carried it. `_receiverCallback` in `contracts/upgradeable_contracts/BasicOmnibridge.sol` calls the receiver this way and ignores the result.
- **The mediator reports the amount before its own fee.** The ledger handles this, because it uses the smaller of `value` and its free balance.
- **No PLS balances.** Native PLS can only enter the ledger from WPLS during an unwrap. PLS forced in by other means is outside the ledger, and `rescueUnaccounted` sends it to `rescueRecipient`.
- **No refunds through the ledger.** A malformed inbound transfer is not sent back. Anyone can rescue it to `rescueRecipient`, and the owner of that account returns it by hand.
