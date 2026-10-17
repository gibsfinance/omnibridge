# Earn a fee on bridges you send: HomeFeeLedger

Status: not deployed. 2026-10-17.

This guide is for a wallet, an app or any other partner that sends users across the gibs bridge. It explains how you earn a fee on each transfer you send. The contract is `contracts/helpers/HomeFeeLedger.sol`. It runs on the home side of the bridge, which is PulseChain.

The contract is unaudited. It has no deployed address yet. The function signatures below are final for this version of the code, but they can change before the first deployment.

## How it works, in short

- You register once and get a partner id.
- Your interface puts that id into each transfer it sends.
- The ledger takes a gibs fee and your partner fee from the transfer, then bridges or pays out the rest.
- The ledger never sends a fee out at once. It credits the fee to your payout account.
- You withdraw your balance when you want, one token at a time.

## Terms

| Term | Meaning |
|---|---|
| Home side | PulseChain. The ledger lives here. |
| Foreign side | The other chain of a bridge, for example Ethereum. |
| Mediator | A bridge contract on the home side. The ledger works only with mediators that its constructor allowed. |
| Gibs fee | The fee that gibs earns. Every gibs fee goes to one fixed account, `gibsCollector`. |
| Partner fee | Your fee. It is added on top of the gibs fee. It is never taken out of the gibs fee. |
| Basis point | One hundredth of one percent. 10,000 basis points is 100 percent. |
| Ledger | The `owed` table. It records what each account can withdraw, per token. |

## What a partner is

A partner is a record in the ledger with a numeric id. The first id is 1. The id 0 means "no partner".

```solidity
struct Partner {
    address payout;            // the account credited with the partner fee
    uint16 rate;               // the partner fee in basis points
    address controller;        // the account that may change this partner
    address pendingController; // the account that may accept control
}
```

Read a partner with `partners(uint256 partnerId)`. Read the number of partners with `partnerCount()`.

## Register

Anyone can register. No approval from gibs is needed.

```solidity
function registerPartner(address payout, uint16 rate) external returns (uint256 partnerId)
```

- The caller becomes the `controller` of the new partner.
- `payout` receives the credits. It must not be the zero address, or the call reverts with `ZeroAddress`.
- `rate` must be at most `MAXIMUM_PARTNER_RATE`, which is 100 basis points (1 percent). A higher rate reverts with `RateTooHigh`.
- The call emits `PartnerRegistered(partnerId, controller, payout, rate)`. Read your id from this event or from the return value.

The controller and the payout account can be different accounts. For example, a cold wallet can control the partner while a hot wallet collects.

## Change your partner

Only the controller can call these functions. Any other caller gets `NotPartnerController`. The gibs admin cannot call them either.

```solidity
function setPartnerPayout(uint256 partnerId, address payout) external
function setPartnerRate(uint256 partnerId, uint16 rate) external
function transferPartnerControl(uint256 partnerId, address newController) external
function acceptPartnerControl(uint256 partnerId) external
```

- `setPartnerPayout` refuses the zero address. Credits that the old payout account already earned stay with the old account.
- `setPartnerRate` refuses a rate above 100 basis points. A rate of 0 is allowed.
- Control moves in two steps. `transferPartnerControl` names the new controller. The new controller then calls `acceptPartnerControl`. Until then, the old controller keeps control.
- No function deletes a partner. To stop earning, set the rate to 0.

## How the fee is set and capped

The total fee on a transfer is the gibs rate plus your partner rate.

| Rate | Who sets it | Ceiling |
|---|---|---|
| Gibs rate (`gibsRate`) | The gibs admin, with `setGibsRate` | `MAXIMUM_GIBS_RATE`, 100 basis points |
| Partner rate | Your controller | `MAXIMUM_PARTNER_RATE`, 100 basis points |

Both ceilings are constants. No function can raise them. So the total can never pass 200 basis points (2 percent).

Each fee is `amount * rate / 10_000`, rounded down.

Every transfer also carries `maximumTotalRate`. This is the highest total rate, in basis points, that the sender agrees to pay. It protects the sender if a rate rises between the quote and the transaction. The two directions use it differently:

- **Outbound:** if the gibs rate plus the partner rate is above `maximumTotalRate`, the transfer reverts with `RateAboveMaximum`.
- **Inbound:** the transfer never reverts for this reason. The ledger charges at most `maximumTotalRate`. It cuts your partner fee first, then the gibs fee.

An inbound example from the tests, with a gibs rate of 100 and a partner rate of 100:

| `maximumTotalRate` | Gibs fee charged | Partner fee charged |
|---|---|---|
| 150 | 100 | 50 |
| 80 | 80 | 0 |
| 0 | 0 | 0 |

The bridge mediators keep their own fee as well. That fee is separate from the ledger. On the PulseChain fork that the tests use (block 27,540,000), the main mediator and the WPLS bridge mediator kept 30 basis points on a home to foreign transfer.

## Outbound: send from PulseChain

Your interface calls the ledger instead of the mediator.

```solidity
function relay(
    address mediator,
    address token,
    uint256 amount,
    address receiver,
    bytes calldata data,
    uint256 partnerId,
    uint16 maximumTotalRate
) external

function relayNative(
    address mediator,
    address receiver,
    bytes calldata data,
    uint256 partnerId,
    uint16 maximumTotalRate
) external payable
```

For `relay`, the user first approves the ledger for `amount` of `token`. For `relayNative`, the user sends PLS as the transaction value. The ledger wraps it into WPLS.

The ledger then does this, in order:

1. It checks that `mediator` is on the allowed list. If not, it reverts with `NotMediator`.
2. It pulls the tokens and measures what arrived. A token that charges a fee on transfer is safe, because the ledger counts only what it received.
3. It checks the partner. An unknown partner id reverts with `UnknownPartner`.
4. It checks the rates against `maximumTotalRate`.
5. It credits the gibs fee to `gibsCollector` and the partner fee to your payout account.
6. It calls `relayTokensAndCall(token, receiver, rest, data)` on the mediator. It passes `data` unchanged and never reads it.
7. It emits `Relayed`.

If any step fails, the whole transaction reverts. Nothing is charged. If nothing arrives, or nothing is left after the fees, the call reverts with `NothingReceived`.

## Inbound: send to PulseChain

A transfer from the foreign side earns a fee only when it is sent to the ledger. On the foreign chain, your interface calls `relayTokensAndCall` on the foreign mediator. It sets the receiver to the ledger address on PulseChain. It sets `data` to exactly this encoding:

```solidity
abi.encode(address recipient, uint256 partnerId, uint16 maximumTotalRate, bool unwrap)
```

The encoding is 128 bytes: four 32-byte words. Set `unwrap` to `true` to pay WPLS out as native PLS. It has no effect for any other token.

On PulseChain, the mediator delivers the tokens to the ledger. Then it calls this function on the ledger:

```solidity
function onTokenBridged(address token, uint256 value, bytes calldata data) external
```

Only an allowed mediator can call it. Any other caller gets `NotMediator`.

### The inbound path never reverts

The mediator ignores a failed callback. If `onTokenBridged` reverted, the tokens would sit in the ledger with no owner. So after the caller check, the function never reverts on purpose. Instead, it handles each problem like this:

| Problem | What happens | Event |
|---|---|---|
| `data` is not exactly 128 bytes, or a word holds bits that its type cannot hold | Nothing is paid. The tokens stay outside the ledger. | `Skipped` with reason `MalformedData` |
| The recipient is the zero address | Same as above. | `Skipped` with reason `ZeroRecipient` |
| No free balance is available | Same as above. | `Skipped` with reason `NothingAvailable` |
| A second delivery starts while one is running | Same as above. | `Skipped` with reason `Reentrant` |
| The partner id is unknown, or 0 | The ledger charges only the gibs fee. | `Delivered` |
| The rates are above `maximumTotalRate` | The ledger cuts the partner fee first, then the gibs fee. | `Delivered` |
| The payment to the recipient fails, for any reason | The ledger credits the rest to the recipient instead. The recipient withdraws it later. | `Credited` with reason `FailedPayout` |
| The native PLS payment fails after the unwrap | The ledger wraps the PLS again and credits WPLS, not PLS. | `Credited` with reason `FailedPayout` |

The ledger never pays out more than it received. It uses the smaller of two numbers: the `value` that the mediator reports, and the balance that the ledger owes to nobody.

Tokens left outside the ledger are not lost. The gibs admin can move them with `rescueUnaccounted`. See the admin section.

"Never reverts" covers the contract's own logic. It cannot cover running out of gas. The callback runs inside the gas that the bridge message carries. If the callback runs out of gas, its changes are undone and the tokens stay outside the ledger. No `Skipped` event is emitted in that case.

## Withdraw

Fees are never sent out at the moment they are earned. Each account withdraws its own balance.

```solidity
function withdraw(address token) external
function withdrawTo(address token, address to) external
```

- Call these from your payout account. They pay the caller's whole balance of `token`.
- `withdrawTo` sends the balance to another account. It refuses the zero address.
- With nothing owed, the call reverts with `NothingToPay`.
- Fees are in the token that was bridged. A partner that earns in five tokens withdraws five times.
- Fees from `relayNative` and from WPLS deliveries are credited in WPLS, not PLS.

Read a balance with `owed(address token, address account)`. Read the sum of all balances of one token with `totalOwed(address token)`.

The zero address as `token` means native PLS. No code path credits native PLS today, so `withdraw(address(0))` always reverts with `NothingToPay`.

## Events to watch

| Event | When |
|---|---|
| `PartnerRegistered(uint256 indexed partnerId, address indexed controller, address payout, uint16 rate)` | A partner registers. |
| `PartnerPayoutSet(uint256 indexed partnerId, address payout)` | The payout account changes. |
| `PartnerRateSet(uint256 indexed partnerId, uint16 rate)` | The partner rate changes. |
| `PartnerControlTransferStarted(uint256 indexed partnerId, address indexed pendingController)` | A control transfer starts. |
| `PartnerControlTransferred(uint256 indexed partnerId, address indexed controller)` | A control transfer completes. |
| `Credited(address indexed token, address indexed account, uint256 amount, CreditReason reason)` | The ledger credits an account. `reason` is `GibsFee` (0), `PartnerFee` (1) or `FailedPayout` (2). |
| `Withdrawn(address indexed token, address indexed account, address indexed to, uint256 amount)` | An account withdraws. |
| `Relayed(address indexed mediator, address indexed token, address indexed sender, address receiver, uint256 received, uint256 sent, uint256 partnerId)` | An outbound transfer reaches the mediator. |
| `Delivered(address indexed mediator, address indexed token, address indexed recipient, uint256 value, uint256 available, uint256 paid, uint256 partnerId)` | An inbound transfer is split and paid. |
| `Skipped(address indexed mediator, address indexed token, uint256 value, SkipReason reason)` | An inbound transfer stays outside the ledger. `reason` is `MalformedData` (0), `ZeroRecipient` (1), `NothingAvailable` (2) or `Reentrant` (3). |
| `GibsRateSet(uint16 rate)` | The gibs rate changes. |
| `AdminTransferStarted(address indexed admin, address indexed pendingAdmin)` | An admin transfer starts. |
| `AdminTransferred(address indexed previousAdmin, address indexed newAdmin)` | The admin role changes hands. The new admin is zero after a renounce. |
| `Rescued(address indexed token, address indexed to, uint256 amount)` | The admin moves tokens that were outside the ledger. |
| `MediatorAllowed(address indexed mediator)` | Once per mediator, at deployment. |

Three details matter when you count your earnings:

- To total your fees, sum `Credited` events where `account` is your payout account and `reason` is `PartnerFee`.
- `Delivered.paid` is the amount meant for the recipient, even when the payment failed. A failed payment also emits `Credited` with reason `FailedPayout`.
- `Delivered.partnerId` and `Relayed.partnerId` repeat the id from the transfer. On the inbound path, an unknown id appears here even though no partner fee was charged.

## Admin powers

The ledger has one admin. The constructor names the first admin.

The admin can do exactly these things:

| Function | Power |
|---|---|
| `setGibsRate(uint16 rate)` | Sets the gibs rate, at most 100 basis points. |
| `rescueUnaccounted(address token, address to)` | Moves the part of the ledger's balance that is not owed to anyone. It never touches `totalOwed`. |
| `transferAdmin(address newAdmin)` | Names a new admin. The new admin must call `acceptAdmin()`. |
| `renounceAdmin()` | Gives up the role for good. The gibs rate and the rescue function are then fixed. |

The admin cannot do any of these things:

- change a partner's payout, rate or controller;
- change or reduce any balance in the ledger;
- withdraw your fees;
- change `gibsCollector`, the wrapped token, or the mediator list;
- raise either rate ceiling;
- pause or upgrade the contract.

`gibsCollector`, `wNative` and the mediator list are fixed in the constructor. The contract has no setter for them, no pause and no upgrade path.

The admin can change the gibs rate between a quote and a transaction. `maximumTotalRate` protects the sender against this. On the inbound path, a higher gibs rate first cuts into your partner fee, because the cap cuts the partner fee first.

## Known limits and open items

- **Not deployed and not audited.** No address exists. No deployment script exists in this repository yet. The first gibs rate is a constructor argument; the tests use 30 basis points, but no production value is decided.
- **Token payout gas is not capped.** On the inbound path, the payment to the recipient gives the token contract all the remaining gas. A native PLS payment is capped at `NATIVE_PAYOUT_GAS`, 100,000 gas. A token that burns all the gas can make the callback run out of gas. Then the delivery stays outside the ledger until the admin rescues it.
- **The deposit forwarder is not wired into the ledger.** The Ethereum deposit addresses send straight to the PulseChain recipient through the main mediator. They do not pass through the ledger, so they earn no partner fee. They charge their own fee on Ethereum instead.
- **Inbound tests use a stand-in for the bridge.** The fork test calls `onTokenBridged` from the real mediator address, but no real bridge message carried it. The mediator code in `contracts/upgradeable_contracts/BasicOmnibridge.sol` (`_receiverCallback`) calls the receiver this way and ignores the result.
- **The mediator reports the amount before its own fee.** The mediator passes the full `value` to the callback but may deliver less. The ledger handles this, because it uses the smaller of `value` and its free balance.
- **No PLS balances.** Native PLS can only enter the ledger from WPLS during an unwrap. PLS forced in by other means is outside the ledger, and only the admin can move it.
- **No refunds through the ledger.** A malformed inbound transfer is not sent back. The admin must rescue it and return it by hand.
