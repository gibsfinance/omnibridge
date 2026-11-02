// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ReentrancyV2} from "./ReentrancyV2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBasicAMBMediator} from "../interfaces/IBasicAMBMediator.sol";
import {IBasicForeignAMB} from "../interfaces/IBasicForeignAMB.sol";
import {IBridgeValidators} from "../interfaces/IBridgeValidators.sol";
import {IOmnibridge} from "../interfaces/IOmnibridge.sol";
import {IWETH as IWNative} from "../interfaces/IWETH.sol";

import {AddressHelper} from "../libraries/AddressHelper.sol";
import {Bytes} from "../libraries/Bytes.sol";

import {OwnableModule} from "../upgradeable_contracts/modules/OwnableModule.sol";
import {Claimable} from "../upgradeable_contracts/Claimable.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";

/**
 * @dev The read surface of the foreign Arbitrary Message Bridge that recovery needs.
 *
 * The router never writes to the bridge. It reads four facts about a message:
 * which message is executing right now, whether a given message was relayed,
 * whether the recipient call for that message reported success, and which
 * contract holds the validator set. The deployed foreign Arbitrary Message
 * Bridge exposes all four.
 */
interface IForeignArbitraryMessageBridge {
    function messageId() external view returns (bytes32);

    function messageCallStatus(bytes32 messageId) external view returns (bool);

    function relayedMessages(bytes32 messageId) external view returns (bool);

    function validatorContract() external view returns (address);
}

/**
 * @dev Answers whether an address is a courier: an address the owner allows to
 * be named on {TokenOmnibridgeBase.safeExecuteSignaturesWithAutoGasLimit} and
 * earn the delivery tip. Couriers are not the bridge's validators. The router
 * implements this itself with its own owner-set list, and is its own filter
 * until the owner points {TokenOmnibridgeBase.setCouriersFilter} elsewhere.
 */
interface ICourierFilter {
    function isCourier(address courier) external view returns (bool);
}

/**
 * @dev The read surface of the mediator's bridged token registry that recovery
 * needs: the local token the mediator mints for a token on the other chain.
 */
interface IBridgedTokenRegistry {
    function bridgedTokenAddress(address nativeToken) external view returns (address);
}

/**
 * @title TokenOmnibridgeBase
 * @dev Omnibridge extension for processing tokens that are not otherwise
 * delivered automatically because of foreign omnibridge settings.
 *
 * RECOVERY OF A STRANDED DELIVERY. The bridge hands tokens to this router and
 * then calls {onTokenBridged}. The mediator that makes that call throws away
 * its result (a bare low-level call), so a delivery that runs out of gas inside
 * {onTokenBridged} leaves the tokens in this router while the bridge records
 * the message as delivered. Nothing a router can do inside {onTokenBridged}
 * makes the mediator report that failure, so the router cannot force the bridge
 * transaction to revert. The router therefore offers {recover}: anyone can
 * finish a stranded delivery afterwards by replaying the signed message.
 *
 * WHO EARNS THE TIP. Any caller of {safeExecuteSignaturesWithAutoGasLimit} who
 * names a courier attributes the tip to that courier; the caller itself does
 * not have to be the courier. The tip is bound to the
 * message the entry is handling: it is paid only on that message's own fresh
 * delivery or recovery, so a relayer has a reason to finish a strand. A public
 * {recover} call never pays a tip, even when it runs inside an entry that is
 * handling a different message, and neither does a recovery through the entry
 * that names an address that is not a courier.
 */
contract TokenOmnibridgeBase is ICourierFilter, OwnableModule, Claimable, ReentrancyV2 {
    using SafeERC20 for IERC20;

    bool public immutable EIP1559_ENABLED;
    address public immutable bridge;
    IWNative public immutable wNative;
    address public couriersFilter;
    /// @dev The owner's courier list. It answers {ICourierFilter.isCourier} for this router.
    mapping(address => bool) public isCourier;

    /**
     * @dev Records every message this router has already paid out, keyed by the
     * Arbitrary Message Bridge message identifier. A normal delivery records its
     * own identifier before it pays, and {recover} records the identifier it
     * replays, so a message can be paid at most once by either path.
     */
    mapping(bytes32 => bool) public processed;

    /**
     * @dev A fresh delivery through {safeExecuteSignaturesWithAutoGasLimit}
     * named an address that the couriers filter does not list as a courier.
     * Only a courier may be attributed the tip on a fresh delivery.
     * @param courier the address the caller named as the courier
     */
    error NotACourier(address courier);
    error WrongExecutor();
    error MessageNotRelayed();
    error MessageNotDelivered();
    error NotForThisRouter();
    error MalformedMessage();
    error UnsupportedSelector();
    error NotEnoughSignatures();
    error InvalidSignature();
    error SignerNotValidator();
    error DuplicateSignature();
    /**
     * @dev The mediator has no local bridged token for the other chain's token
     * that a bridged-token message names, so recovery cannot tell what to pay.
     * @param messageToken the token address the message names, on the other chain
     */
    error UnknownBridgedToken(address messageToken);
    /**
     * @dev A fresh delivery to this router through the single entry returned
     * from the bridge without this router recording the message as paid: the
     * mediator swallowed a failed {onTokenBridged}. Reverting keeps the tokens
     * out of the router and leaves the message unrelayed, so it can be retried.
     * @param messageId the Arbitrary Message Bridge message identifier
     */
    error DeliveryNotCompleted(bytes32 messageId);
    /**
     * @dev The 20-byte legacy data form (a bare recipient address) means
     * "unwrap the wrapped native token", so it is accepted only for that token.
     * A bridged token whose other-chain address equals the wrapped native
     * token (PulseChain's copy of WETH) arrives here as the mediator's bridged
     * twin and is refused, so it can never unwrap other users' wrapped token.
     * @param token the local token the delivery carries
     */
    error LegacyFormRequiresWrappedNative(address token);
    /**
     * @dev {onTokenBridged} ran while the bridge reported no executing message
     * (a zero identifier). The live bridge always sets the identifier before it
     * calls the mediator, so this never happens on a real delivery. Paying here
     * would record nothing, and a later {recover} could pay the message again.
     */
    error ExecutingMessageIdentifierMissing();

    /**
     * @dev What a call to the single entry or to {recover} did. A relayer that
     * simulates its call first reads this to learn whether it would win.
     * @custom:value Delivered the entry relayed a fresh message through the bridge
     * @custom:value Recovered the message had stranded in this router and was paid now
     * @custom:value AlreadyHandled this router had already paid the message (another
     * caller won the race); the call returned at once and changed nothing
     * @custom:value AlreadyRelayedForAnotherRecipient the bridge had already relayed
     * the message, and the message does not deliver to this router, so this router
     * can never pay it; the entry returned at once and changed nothing. Only the
     * single entry returns it; {recover} reverts for such a message instead
     */
    enum DeliveryOutcome {
        Delivered,
        Recovered,
        AlreadyHandled,
        AlreadyRelayedForAnotherRecipient
    }

    /**
     * @dev Emitted when {recover} finishes a stranded delivery.
     * @param messageId the Arbitrary Message Bridge message identifier that was recovered
     * @param token the local token paid out: the token the mediator really sent
     * this router, which for a bridged-token message is the mediator's bridged
     * token and not the other chain's address that the message names
     * @param recipient the recipient the message names, which recovery requires to
     * be this router (the end recipient is inside the fee director data)
     * @param value the amount paid out, split between the end recipient and
     * any delivery tip: the value the message names, capped at what the router
     * held of the token (see {_payableAmount})
     */
    event DeliveryRecovered(bytes32 indexed messageId, address indexed token, address indexed recipient, uint256 value);

    /**
     * @dev The selectors of the three mediator callbacks that deliver to a
     * receiver and carry extra data. The two handle callbacks share the layout
     * (token, recipient, value, data). The first transfer of a token arrives as
     * the deploy callback instead, with the layout (token, name, symbol,
     * decimals, recipient, value, data).
     */
    bytes4 private constant HANDLE_BRIDGED_SELECTOR = bytes4(keccak256("handleBridgedTokensAndCall(address,address,uint256,bytes)"));
    bytes4 private constant HANDLE_NATIVE_SELECTOR = bytes4(keccak256("handleNativeTokensAndCall(address,address,uint256,bytes)"));
    bytes4 private constant DEPLOY_AND_HANDLE_BRIDGED_SELECTOR =
        bytes4(keccak256("deployAndHandleBridgedTokensAndCall(address,string,string,uint8,address,uint256,bytes)"));

    bytes32 public constant COURIER_SLOT = keccak256(abi.encode("omnibridgerouter.courier"));

    /**
     * @dev The storage slot that holds the identifier of the message the single
     * entry {safeExecuteSignaturesWithAutoGasLimit} is handling right now. A
     * payout earns the courier's tip only when its own message identifier equals
     * this one, so code that runs during the entry (an arbitrary message's
     * target, a hostile token) cannot make some other payout pay the courier.
     */
    bytes32 private constant ENTRY_MESSAGE_SLOT = keccak256(abi.encode("omnibridgerouter.entryMessage"));

    /**
     * @dev The entry message slot's idle value: no entry is running. It is not
     * zero, so each entry rewrites a non-zero slot instead of paying for a
     * fresh one. No bridge message identifier is ever 1 (the identifier
     * carries a version prefix in its high bytes).
     */
    bytes32 private constant _IDLE_ENTRY_MESSAGE = bytes32(uint256(1));

    /**
     * @dev The most gas a native coin payout hands the recipient (the call adds
     * the 2,300 stipend on top). Without a cap a recipient that burns its gas
     * leaves this router 1/64 of what remained, too little to fall back to the
     * wrapped token, and the delivery strands with the relayer unpaid.
     *
     * The number must still cover smart-contract wallets. A Safe 1.3.0 proxy's
     * receive (cold storage read of the singleton, cold delegate call, one event)
     * measured about 6,700 gas on Ethereum mainnet; ERC-4337 accounts and other
     * proxy wallets follow the same proxy-plus-event shape. 50,000 leaves more
     * than seven times that, and bounds what a hostile recipient can burn per
     * payout. A recipient that needs more receives the wrapped token instead.
     */
    uint256 private constant NATIVE_PAYOUT_GAS_LIMIT = 50_000;

    /**
     * @dev Initializes this contract.
     * @param _bridge address of the HomeOmnibridge/ForeignOmnibridge contract.
     * @param _wNative address of the WNative token used for wrapping/unwrapping native coins (e.g. WETH/WBNB/WXDAI).
     * @param _owner address of the contract owner.
     */
    constructor(address _bridge, IWNative _wNative, address _owner, bool _EIP1559_ENABLED) OwnableModule(_owner) {
        bridge = _bridge;
        wNative = _wNative;
        _wNative.approve(address(_bridge), type(uint256).max);
        couriersFilter = address(this);
        EIP1559_ENABLED = _EIP1559_ENABLED;
        StorageSlot.getBytes32Slot(ENTRY_MESSAGE_SLOT).value = _IDLE_ENTRY_MESSAGE;
    }

    struct FeeDirector {
        address recipient;
        // a list of up to 256 flags for modifying how the contract handles tokens
        // 0th index is to use the limit as the fee amount
        // 1st index is to unwrap the tokens
        // 2nd is to ask the system to not include the priority fee
        // 3rd is to use the multiplier as a factor of total tokens; in this
        //     mode the limit is NOT applied, the fee is capped only by the value
        // if a base fee is available it will only use that
        // With neither bit 0 nor bit 3 set (the gas mode), the fee is the gas
        // formula capped at the limit.
        uint256 settings;
        uint256 limit;
        uint256 multiplier;
    }

    /**
     * @dev The fields of a supported mediator callback, exactly as the message
     * carries them (see {_decodeHandleCallFields}).
     * @custom:field selector the mediator callback selector
     * @custom:field messageToken the token address the message names (see {_localToken})
     * @custom:field recipient the recipient the message names
     * @custom:field value the amount the message names
     * @custom:field data the extra data the message carries for the recipient
     */
    struct HandleCall {
        bytes4 selector;
        address messageToken;
        address recipient;
        uint256 value;
        bytes data;
    }

    /**
     * @dev Bridged callback function used for unwrapping received tokens.
     * Can only be called by the associated Omnibridge contract.
     * @param _token the local token the mediator just sent this router: the
     * native token itself for handleNativeTokensAndCall, or the mediator's
     * bridged token for the bridged-token callbacks. Any token is accepted;
     * only the 20-byte legacy data form requires the wrapped native token.
     * @param _value amount of bridged/received tokens.
     * @param _data extra data passed alongside with relayTokensAndCall
     * on the other side of the bridge. Should contain coins receiver address.
     */
    function onTokenBridged(address _token, uint256 _value, bytes memory _data) external payable virtual nonReentrant {
        require(msg.sender == address(bridge));
        // Record the message that is executing now, so a later {recover} can
        // never pay this message a second time. The read is strict: a zero
        // identifier reverts {ExecutingMessageIdentifierMissing} rather than pay
        // without a record. A delivery that later reverts unwinds this write
        // along with everything else.
        bytes32 messageIdentifier = _currentMessageId();
        _markProcessed(messageIdentifier);
        _distributeDelivery(_token, _payableAmount(_token, _value), _data, messageIdentifier);
    }

    /**
     * @dev Delivers `value` of `token` according to `data`. Shared by
     * {onTokenBridged} and {_recover}. The delivery tip is paid only to the
     * courier {_courierEarningTipFor} returns for `messageIdentifier`: the entry
     * must be handling this very message with a courier attributed. So a
     * stranded delivery finished through the single entry pays the courier the
     * same tip a fresh delivery would, which gives a relayer a reason to finish
     * a strand. A public {recover} call, a recovery that names a non-courier (whose courier
     * address the entry cleared), or the payout of any other message that runs
     * while the entry is busy pays the recipient in full.
     * @param token the local token to pay out
     * @param value the amount to pay out, split between recipient and tip
     * @param data the fee director data, or the 20-byte legacy recipient form
     * @param messageIdentifier the identifier of the message being paid
     */
    function _distributeDelivery(address token, uint256 value, bytes memory data, bytes32 messageIdentifier) internal {
        if (data.length == 20) {
            // handling legacy wNative -> Native
            if (token != address(wNative)) revert LegacyFormRequiresWrappedNative(token);
            wNative.withdraw(value);
            _distribute(true, address(wNative), Bytes.bytesToAddress(data), value);
            return;
        }
        FeeDirector memory feeDirector = abi.decode(data, (FeeDirector));
        // bit 1 (the second bit from the right) is the signal to unwrap the tokens
        bool toNative = feeDirector.settings << 254 >> 255 == 1 && address(wNative) == token;
        // handling wNative -> Native
        if (toNative) {
            wNative.withdraw(value);
        }
        uint256 courierWord = _courierEarningTipFor(messageIdentifier);
        uint256 fees;
        uint256 toRecipient = value;
        if (courierWord != 0) {
            // the entry is handling this very message: its courier earns the fee
            (fees, toRecipient) = _feeInfo(toNative, value, courierWord, feeDirector);
        }
        if (toRecipient > 0) {
            _distribute(toNative, token, feeDirector.recipient, toRecipient);
        }
        if (fees > 0) {
            _distribute(toNative, token, address(uint160(courierWord >> 96)), fees);
        }
    }

    /**
     * @dev Finishes a delivery that stranded in this router, by replaying the
     * signed Arbitrary Message Bridge message. A call to this function never
     * pays a delivery tip, whoever makes it and whenever it runs: the
     * recipient receives the full value. (A courier named on
     * {safeExecuteSignaturesWithAutoGasLimit} earns the tip when that entry
     * finishes the same message.)
     *
     * The caller supplies the exact message bytes and the validator signatures,
     * the same pair the bridge accepted. This function trusts nothing the caller
     * asserts about that pair. The checks run in this order, like an HTTP 400
     * before a 409: is the message for this router, then has it already been
     * paid, then did the bridge deliver it, then do the signatures hold.
     *
     *   1. The message is for this router: it ran through THIS router's own
     *      mediator ({WrongExecutor}), with a callback this router delivers
     *      ({UnsupportedSelector}, {MalformedMessage}), naming THIS router as
     *      the recipient ({NotForThisRouter}). Calldata only.
     *   2. This router has not already paid it. A message already paid is not an
     *      error: the call returns {DeliveryOutcome.AlreadyHandled} before any
     *      storage write or external call, so a caller who lost a race to the
     *      same message spends as little gas as possible.
     *   3. The bridge relayed the message and recorded the mediator call as
     *      successful (which is what a stranded delivery looks like, and is
     *      false for a message that failed and was refunded on the other chain).
     *   4. The signatures hold against the live validator set. They gate every
     *      payment: only after them does the call resolve the local token and
     *      pay, and it records the identifier first so the same message cannot
     *      be paid twice.
     *
     * A message that is not for this router reverts at step 1 even when this
     * router paid a message with the same identifier: `processed` speaks only
     * for messages to this router. (The single entry returns
     * {DeliveryOutcome.AlreadyRelayedForAnotherRecipient} for such a message
     * once the bridge relayed it, but a caller of this function asked to
     * recover something that cannot be recovered here.)
     *
     * @param message the Arbitrary Message Bridge message, exactly as signed
     * @param signatures the validator signatures over that message
     * @return outcome {DeliveryOutcome.Recovered} when this call paid the
     * message, {DeliveryOutcome.AlreadyHandled} when it was already paid
     */
    function recover(bytes calldata message, bytes calldata signatures) external returns (DeliveryOutcome outcome) {
        (bytes32 messageIdentifier, address executor, bytes calldata innerCall) = _parseMessage(message);
        // Steps 1 and 2 run here, before the reentrancy guard's write, so a
        // caller who sent a message for someone else or lost a race spends
        // little gas. The recovery body repeats both, so it stands alone.
        _requireDeliversToThisRouter(executor, innerCall);
        if (processed[messageIdentifier]) {
            return DeliveryOutcome.AlreadyHandled;
        }
        return _recoverWithReentrancyGuard(message, signatures);
    }

    /**
     * @dev Runs {_recover} while holding the reentrancy guard that
     * {onTokenBridged} also holds. Both recovery paths go through here: the
     * public {recover} and the recovery branch of the single delivery entry.
     * The entry's own guard is the courier slot, not this one, so this guard is
     * what stops a payout recipient from re-entering {recover} (or making the
     * bridge deliver to {onTokenBridged}) in the middle of a recovery. The tip
     * itself is bound to the message (see {_courierEarningTipFor}), so a payout
     * of another message would pay no tip even without this guard.
     */
    function _recoverWithReentrancyGuard(bytes calldata message, bytes calldata signatures)
        internal
        nonReentrant
        returns (DeliveryOutcome outcome)
    {
        return _recover(message, signatures);
    }

    /**
     * @dev The recovery body, shared (through {_recoverWithReentrancyGuard}) by
     * the public {recover} and by the single delivery entry
     * {safeExecuteSignaturesWithAutoGasLimit}. It follows
     * checks-effects-interactions: it records the message as processed before it
     * moves any tokens, so a re-entrant call for the same message finds it
     * already processed. It takes no reentrancy modifier of its own; its one
     * caller, {_recoverWithReentrancyGuard}, holds it.
     *
     * The checks run in the order {recover} describes: is the message for this
     * router (calldata only), has it already been paid (one storage read),
     * did the bridge deliver it (bridge reads), and do the signatures hold.
     * None of the first three can lead to a payment, only to an exit. The
     * validator signatures come next and gate everything after them: the
     * token lookup and the payment. Both callers already ran the first two
     * checks; the body repeats them so it never depends on its caller, and its
     * `processed` check is the defence in depth against a double payment.
     */
    function _recover(bytes calldata message, bytes calldata signatures) internal returns (DeliveryOutcome outcome) {
        (bytes32 messageIdentifier, address executor, bytes calldata innerCall) = _parseMessage(message);
        // The message must be for this router: through its own mediator (the
        // only caller {onTokenBridged} accepts), with a callback it delivers,
        // naming it as the recipient.
        HandleCall memory handleCall = _requireDeliversToThisRouter(executor, innerCall);
        // Losing a race is not an error: nothing is written and nothing is paid.
        if (processed[messageIdentifier]) return DeliveryOutcome.AlreadyHandled;

        address validatorContract = _requireDeliveredByBridge(messageIdentifier);
        // Everything above can only exit. From here on the call can pay, so the
        // validator signatures must hold first.
        _verifySignatures(validatorContract, message, signatures);
        _payRecoveredMessage(messageIdentifier, handleCall);
        return DeliveryOutcome.Recovered;
    }

    /**
     * @dev The cheap recovery checks that need the bridge but no signatures.
     * Reverts unless the bridge relayed the message and the mediator call
     * succeeded. Pays nothing.
     * @param messageIdentifier the identifier parsed from the message
     * @return validatorContract the bridge's validator set, for the signature check
     */
    function _requireDeliveredByBridge(bytes32 messageIdentifier) internal view returns (address validatorContract) {
        IForeignArbitraryMessageBridge arbitraryMessageBridge = _arbitraryMessageBridge();
        // relayedMessages is set before the recipient call, so it alone does not
        // prove the tokens arrived. messageCallStatus is the mediator's own call
        // result: true for a stranded delivery (the mediator swallows the failed
        // recipient callback and returns success), and false for a message that
        // failed outright and was refunded on the other chain. Both gates together
        // admit only a message whose tokens really reached this router.
        if (!arbitraryMessageBridge.relayedMessages(messageIdentifier)) revert MessageNotRelayed();
        if (!arbitraryMessageBridge.messageCallStatus(messageIdentifier)) revert MessageNotDelivered();
        return arbitraryMessageBridge.validatorContract();
    }

    /**
     * @dev The Arbitrary Message Bridge that this router's mediator trusts: the
     * one that relays every message this router can be paid for.
     */
    function _arbitraryMessageBridge() internal view returns (IForeignArbitraryMessageBridge) {
        return IForeignArbitraryMessageBridge(address(IBasicAMBMediator(bridge).bridgeContract()));
    }

    /**
     * @dev Pays a recovered message once the signatures have passed. Resolves
     * the local token the mediator really sent (see {_localToken}), and records
     * the message as processed before it moves any tokens.
     * @param messageIdentifier the identifier parsed from the message
     * @param handleCall the callback fields, already checked to name this
     * router as the recipient (see {_requireDeliversToThisRouter})
     */
    function _payRecoveredMessage(bytes32 messageIdentifier, HandleCall memory handleCall) internal {
        address localToken = _localToken(handleCall.selector, handleCall.messageToken);
        // The same rule as a fresh delivery: pay what the message names, capped
        // at what the router holds of the token right now.
        uint256 value = _payableAmount(localToken, handleCall.value);

        _markProcessed(messageIdentifier);
        // Same distribution as a fresh delivery: when the single entry is handling
        // this very message with a listed courier, that courier earns the tip;
        // a public recover() or a non-courier pays the recipient in full.
        _distributeDelivery(localToken, value, handleCall.data, messageIdentifier);
        emit DeliveryRecovered(messageIdentifier, localToken, handleCall.recipient, value);
    }

    /**
     * @dev The amount a delivery of `token` pays out, for both a fresh delivery
     * and a recovery: the value the message names, capped at the router's
     * balance of the token read now.
     *
     * The rule follows the owner's decision for fee-on-transfer (tax,
     * reflection) tokens: never refuse them, pay from the balance read at run
     * time. The balance is shared by every strand of the token in this router,
     * so a delivery whose own tokens arrived short can draw on another strand
     * of the same token, and a later message may then find less than it names
     * and be paid the smaller amount (the message is closed once paid). The
     * owner's {claimTokens} is the rescue path that makes any good-faith actor
     * left short whole.
     * @param token the local token being paid
     * @param value the value the message names
     * @return the amount to pay: the smaller of `value` and the balance
     */
    function _payableAmount(address token, uint256 value) internal view returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < value) {
            return balance;
        }
        return value;
    }

    /**
     * @dev The courier word (entry gas in the low 96 bits, courier address above)
     * that earns the delivery tip on the payout of `messageIdentifier`, or zero
     * when no one does. A courier earns the tip only when all three hold: the
     * single entry has a courier attributed (a non-zero courier address), the
     * entry is handling this very message, and the identifier is known (not
     * zero). A public {recover} call, a recovery that names a non-courier (the entry keeps
     * its gas but clears the address), or any payout of a different message
     * that runs while the entry is busy, therefore pays no tip. The idle slot
     * value 1 also has a zero address.
     * @param messageIdentifier the identifier of the message being paid: the
     * bridge's live identifier on a fresh delivery, the parsed identifier on a
     * recovery
     */
    function _courierEarningTipFor(bytes32 messageIdentifier) internal view returns (uint256) {
        if (messageIdentifier == bytes32(0)) {
            return 0;
        }
        if (StorageSlot.getBytes32Slot(ENTRY_MESSAGE_SLOT).value != messageIdentifier) {
            return 0;
        }
        uint256 courierWord = StorageSlot.getUint256Slot(COURIER_SLOT).value;
        if (courierWord >> 96 == 0) {
            return 0;
        }
        return courierWord;
    }

    /**
     * @dev Distributes tokens to a recipient. For a native payout that the
     * recipient refuses, or cannot finish within {NATIVE_PAYOUT_GAS_LIMIT}, it
     * falls back to delivering the wrapped token rather than reverting, so a
     * recipient that cannot receive the native coin never strands the transfer.
     */
    function _distribute(bool native, address token, address recipient, uint256 amount) internal {
        if (!native) {
            IERC20(token).safeTransfer(recipient, amount);
            return;
        }
        bool success;
        // Assembly so the recipient's return data is never copied: a high-level
        // call copies it into memory, which the recipient could make costly.
        assembly {
            success := call(NATIVE_PAYOUT_GAS_LIMIT, recipient, amount, 0, 0, 0, 0)
        }
        if (success) {
            return;
        }
        // the recipient cannot receive the native coin: re-wrap and deliver the
        // wrapped token to the same recipient instead of reverting
        wNative.deposit{value: amount}();
        IERC20(address(wNative)).safeTransfer(recipient, amount);
    }

    function _feeInfo(bool toNative, uint256 _value, uint256 courierWord, FeeDirector memory feeDirector)
        internal
        view
        returns (uint256 fees, uint256 toRecipient)
    {
        // use the limit as the fee
        if (feeDirector.settings << 255 >> 255 == 1) {
            fees = feeDirector.limit;
        } else if (feeDirector.settings << 252 >> 255 == 1) {
            // a share of the value; the limit is deliberately not applied here,
            // only the value cap below bounds this fee
            fees = (_value * feeDirector.multiplier) / 1 ether;
        } else {
            // a courier has been named (does not have to match sender)
            uint256 gasUsed = uint256(uint96(courierWord)) - gasleft();
            // gas mode: extra 50k added for 2x transfer handling + 10%
            // to cover profit motive + risk compensation
            uint256 baselineFee = _baseFee((feeDirector.settings << 253 >> 255) == 1);
            fees = (
                (
                    gasUsed
                    // this is an unwrap, different costs for tokens vs native
                    + (toNative ? 50_000 : 100_000)
                ) * feeDirector.multiplier * baselineFee
            ) / 1 ether;
            // fees must not be greater than limit
            fees = fees > feeDirector.limit ? feeDirector.limit : fees;
        }
        // fees must not be greater than value
        fees = fees > _value ? _value : fees;
        toRecipient = _value - fees;
    }

    function feeInfo(bool toNative, uint256 _value, uint256 courierWord, FeeDirector calldata feeDirector)
        external
        view
        returns (uint256, uint256)
    {
        return _feeInfo(toNative, _value, courierWord, feeDirector);
    }

    function baseFee(bool excludePriority) external view returns (uint256) {
        return _baseFee(excludePriority);
    }

    function _baseFee(bool excludePriority) internal view returns (uint256) {
        return EIP1559_ENABLED && excludePriority ? block.basefee : tx.gasprice;
    }

    /**
     * @dev Marks a message paid so it can never be paid again. The one place
     * `processed` is written: {onTokenBridged} feeds it the live identifier read
     * from the bridge (never zero, see {_currentMessageId}), {_recover} feeds it
     * the identifier parsed from the signed message. Every identifier is
     * recorded, zero included, so no message can be paid twice.
     */
    function _markProcessed(bytes32 messageIdentifier) internal {
        processed[messageIdentifier] = true;
    }

    /**
     * @dev Reads the identifier of the message that is executing right now from
     * this router's mediator's Arbitrary Message Bridge.
     *
     * The read is strict. The live bridge always sets the identifier before it
     * calls the mediator, and the mediator reads it itself during the callback,
     * so a real delivery always has a non-zero identifier. A zero identifier
     * reverts {ExecutingMessageIdentifierMissing}, and a bridge that cannot
     * answer at all makes the call revert.
     * @return messageIdentifier the identifier of the executing message, never zero
     */
    function _currentMessageId() internal view returns (bytes32 messageIdentifier) {
        messageIdentifier = _arbitraryMessageBridge().messageId();
        if (messageIdentifier == bytes32(0)) revert ExecutingMessageIdentifierMissing();
    }

    /**
     * @dev Unpacks the fields {recover} needs from an Arbitrary Message Bridge
     * message. The layout is fixed: 32 bytes message identifier, 20 bytes
     * sender, 20 bytes executor, 4 bytes gas limit, 1 byte source chain id
     * length, 1 byte destination chain id length, 1 byte data type, then the two
     * chain ids, then the executor's calldata.
     */
    function _parseMessage(bytes calldata message)
        internal
        pure
        returns (bytes32 messageIdentifier, address executor, bytes calldata innerCall)
    {
        if (message.length < 79) revert MalformedMessage();
        assembly {
            messageIdentifier := calldataload(message.offset)
            // executor sits 52 bytes in; load 32 bytes from there and keep the top 20
            executor := shr(96, calldataload(add(message.offset, 52)))
        }
        uint256 sourceChainIdLength = uint8(message[76]);
        uint256 destinationChainIdLength = uint8(message[77]);
        uint256 innerStart = 79 + sourceChainIdLength + destinationChainIdLength;
        if (message.length < innerStart) revert MalformedMessage();
        innerCall = message[innerStart:];
    }

    /**
     * @dev Decodes the fields of a supported mediator callback exactly as the
     * message carries them. Accepts only the three "and call" selectors that
     * carry a fee director, which is exactly the shape this router delivers;
     * reverts {UnsupportedSelector} for anything else and {MalformedMessage}
     * for a call too short to hold a selector. The token it returns is the
     * address the message names, not yet the local token (see {_localToken}).
     * @param innerCall the mediator callback the message carries
     * @return handleCall the callback fields
     */
    function _decodeHandleCallFields(bytes calldata innerCall) internal pure returns (HandleCall memory handleCall) {
        if (innerCall.length < 4) revert MalformedMessage();
        handleCall.selector = bytes4(innerCall[0:4]);
        if (!_isSupportedHandleSelector(handleCall.selector)) revert UnsupportedSelector();
        if (handleCall.selector == DEPLOY_AND_HANDLE_BRIDGED_SELECTOR) {
            (handleCall.messageToken, handleCall.recipient, handleCall.value, handleCall.data) =
                _decodeDeployCallFields(innerCall[4:]);
            return handleCall;
        }
        (handleCall.messageToken, handleCall.recipient, handleCall.value, handleCall.data) =
            abi.decode(innerCall[4:], (address, address, uint256, bytes));
    }

    /**
     * @dev Decodes the arguments of deployAndHandleBridgedTokensAndCall
     * (token, name, symbol, decimals, recipient, value, data) and keeps the four
     * that delivery needs. The name, symbol and decimals only matter to the
     * mediator when it deploys the bridged token.
     * @param arguments the callback's abi-encoded arguments, without the selector
     */
    function _decodeDeployCallFields(bytes calldata arguments)
        internal
        pure
        returns (address messageToken, address recipient, uint256 value, bytes memory data)
    {
        (messageToken,,,, recipient, value, data) =
            abi.decode(arguments, (address, string, string, uint8, address, uint256, bytes));
    }

    /**
     * @dev Whether a selector is one of the mediator callbacks this router
     * delivers and can recover.
     */
    function _isSupportedHandleSelector(bytes4 selector) internal pure returns (bool) {
        return selector == HANDLE_BRIDGED_SELECTOR || selector == HANDLE_NATIVE_SELECTOR
            || selector == DEPLOY_AND_HANDLE_BRIDGED_SELECTOR;
    }

    /**
     * @dev Whether a message delivers tokens to this router through this
     * router's own mediator, using a callback this router handles. Calldata
     * only: `bridge` is immutable, so this makes no storage read and no
     * external call. Never reverts for a message that is for someone else.
     * The single entry's answer to "is this message for us?".
     * @param executor the executor parsed from the message
     * @param innerCall the mediator callback parsed from the message
     */
    function _deliversToThisRouter(address executor, bytes calldata innerCall) internal view returns (bool) {
        if (executor != bridge) return false;
        if (innerCall.length < 4) return false;
        if (!_isSupportedHandleSelector(bytes4(innerCall[0:4]))) return false;
        return _decodeHandleCallFields(innerCall).recipient == address(this);
    }

    /**
     * @dev The recovery's answer to "is this message for us?": the same test
     * as {_deliversToThisRouter}, but it reverts with the reason instead of
     * returning false. Calldata only, no storage read and no external call.
     * @param executor the executor parsed from the message
     * @param innerCall the mediator callback parsed from the message
     * @return handleCall the callback fields, for the payment
     */
    function _requireDeliversToThisRouter(address executor, bytes calldata innerCall)
        internal
        view
        returns (HandleCall memory handleCall)
    {
        if (executor != bridge) revert WrongExecutor();
        handleCall = _decodeHandleCallFields(innerCall);
        if (handleCall.recipient != address(this)) revert NotForThisRouter();
    }

    /**
     * @dev Resolves the token a mediator callback really moved on this chain.
     *
     * handleNativeTokensAndCall names a token that is native to this chain, and
     * the mediator transfers that same address out of its custody
     * (BasicOmnibridge.handleNativeTokensAndCall), so the message token is the
     * local token.
     *
     * The bridged-token callbacks (handleBridgedTokensAndCall and the
     * first-transfer deployAndHandleBridgedTokensAndCall) name the token's
     * address on the OTHER chain. The mediator converts it with
     * bridgedTokenAddress before it mints (BasicOmnibridge's
     * handleBridgedTokensAndCall, and _getBridgedTokenOrDeploy, which pairs a
     * newly deployed token first). An address on the other chain
     * can equal a real token's address here (PulseChain copied Ethereum's state),
     * so paying the message token would pay a different, real token out of other
     * users' funds. The pairing is set once and never cleared, so the lookup
     * today returns the token the mediator minted when the message ran.
     * @param selector the mediator callback selector from the message
     * @param messageToken the token address the message names
     * @return the local token the mediator sent this router
     */
    function _localToken(bytes4 selector, address messageToken) internal view returns (address) {
        if (selector == HANDLE_NATIVE_SELECTOR) {
            return messageToken;
        }
        address bridgedToken = IBridgedTokenRegistry(bridge).bridgedTokenAddress(messageToken);
        if (bridgedToken == address(0)) revert UnknownBridgedToken(messageToken);
        return bridgedToken;
    }

    /**
     * @dev Reproduces the bridge's own signature check over a message. Reverts
     * unless at least `requiredSignatures` distinct validators signed the
     * message. The signatures blob is one count byte, then that many `v` bytes,
     * then that many 32-byte `r` words, then that many 32-byte `s` words.
     */
    function _verifySignatures(address validatorContract, bytes calldata message, bytes calldata signatures)
        internal
        view
    {
        uint256 requiredSignatures = IBridgeValidators(validatorContract).requiredSignatures();
        if (signatures.length < 1) revert NotEnoughSignatures();
        uint256 count = uint8(signatures[0]);
        if (count < requiredSignatures) revert NotEnoughSignatures();
        if (signatures.length < 1 + count + 64 * count) revert NotEnoughSignatures();

        bytes32 hash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n", _uintToString(message.length), message)
        );

        address[] memory seen = new address[](requiredSignatures);
        for (uint256 i = 0; i < requiredSignatures; i++) {
            uint8 v = uint8(signatures[1 + i]);
            bytes32 r;
            bytes32 s;
            uint256 rPosition = 1 + count + 32 * i;
            uint256 sPosition = 1 + count + 32 * count + 32 * i;
            assembly {
                r := calldataload(add(signatures.offset, rPosition))
                s := calldataload(add(signatures.offset, sPosition))
            }
            address recovered = ecrecover(hash, v, r, s);
            if (recovered == address(0)) revert InvalidSignature();
            if (!IBridgeValidators(validatorContract).isValidator(recovered)) revert SignerNotValidator();
            for (uint256 j = 0; j < i; j++) {
                if (seen[j] == recovered) revert DuplicateSignature();
            }
            seen[i] = recovered;
        }
    }

    /// @dev Decimal string of a number, matching the bridge's message hashing.
    function _uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 digits = value;
        uint256 length;
        while (digits != 0) {
            length++;
            digits /= 10;
        }
        bytes memory buffer = new bytes(length);
        while (value != 0) {
            length -= 1;
            buffer[length] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    /**
     * @dev Claims stuck coins/tokens.
     * Only contract owner can call this method.
     * @param _token address of claimed token contract, address(0) for native coins.
     * @param _to address of tokens receiver
     */
    function claimTokens(address _token, address _to) external onlyOwner {
        claimValues(_token, _to);
    }

    /**
     * @dev Ether receive function.
     * Accepts ether only from the wNative contract, which pays this router when
     * it unwraps. Reverts for every other sender. The wrapping relay functions
     * of the derived routers (wrapAndRelayTokens, relayTokensAndCall) wrap all
     * the ether they receive. {onTokenBridged},
     * {safeExecuteSignaturesWithAutoGasLimit}, {setCouriersFilter} and
     * {setCourierStatus} are payable to save gas; ether sent to them by
     * mistake stays in the router until the owner claims it with
     * {claimTokens}.
     */
    receive() external payable {
        require(msg.sender == address(wNative));
    }
    /**
     * @dev Validates provided signatures and relays a given message, or finishes
     * it when it already stranded (see the branch comment below).
     *
     * A fresh message runs through the bridge's "safe" delivery, which reverts
     * when the mediator call fails. The bridge sees only the mediator's result,
     * and the mediator swallows a failed receiver callback, so the bridge alone
     * would let a delivery to this router strand inside this very transaction.
     * When the message delivers to this router, the router therefore also
     * requires that {onTokenBridged} recorded the message, and reverts
     * {DeliveryNotCompleted} otherwise: this router's own delivery is all or
     * nothing. A message for any other recipient gets only the bridge's check.
     *
     * The entry first asks "is this message for us?" (calldata only), and only
     * then "has it already been done?", like an HTTP 400 before a 409:
     *
     *   - A message that delivers to this router and that this router has
     *     already paid returns {DeliveryOutcome.AlreadyHandled} after one
     *     storage read, before any storage write or external call: losing a
     *     race to another relayer is not an error.
     *   - A message that does not deliver to this router is never answered
     *     from `processed`, which records only this router's own payments. If
     *     the bridge already relayed it, the entry returns
     *     {DeliveryOutcome.AlreadyRelayedForAnotherRecipient} after one bridge
     *     read and before any storage write: this router can never pay it.
     *   - Anything else runs: a fresh relay, or the recovery of a strand.
     *
     * Relayers should simulate the call first and read the returned outcome.
     * @param courier the courier to attribute the tip to. Any caller may name
     * any courier; the tip goes to the courier, not to the caller. A fresh
     * delivery reverts {NotACourier} for an address that is not a courier; a
     * recovery accepts any address but pays a non-courier no tip.
     * @param _data bytes to be relayed
     * @param _signatures bytes blob with signatures to be validated
     * @notice that the sender does not matter, so this method could be called via
     * multicall for more efficient gas savings and still attribute tokens to the courier appropriately
     * @return outcome {DeliveryOutcome.Delivered} for a fresh relay,
     * {DeliveryOutcome.Recovered} for a finished strand,
     * {DeliveryOutcome.AlreadyHandled} when the router had already paid it, or
     * {DeliveryOutcome.AlreadyRelayedForAnotherRecipient} when the bridge had
     * already relayed a message that is not for this router
     */
    function safeExecuteSignaturesWithAutoGasLimit(address courier, bytes calldata _data, bytes calldata _signatures)
        external
        payable
        returns (DeliveryOutcome outcome)
    {
        // Read first, so the gas-mode tip measures from the same point as before
        // the cheap checks below were added.
        uint256 entryGas = gasleft();
        // Parsed once; every check below and the dispatch reuse the parts.
        (bytes32 messageIdentifier, address executor, bytes calldata innerCall) = _parseMessage(_data);
        // "Is this message for us?" first: calldata only.
        bool deliversToThisRouter = _deliversToThisRouter(executor, innerCall);
        // For us and already paid: a caller who lost the race returns here, after
        // one storage read and before the courier slot write or any external call.
        if (deliversToThisRouter && processed[messageIdentifier]) {
            return DeliveryOutcome.AlreadyHandled;
        }
        // Not for us: `processed` says nothing about this message, so the bridge
        // answers instead. One bridge read, still before the courier slot write
        // and the signature check.
        if (!deliversToThisRouter && _isRelayedByBridge(messageIdentifier)) {
            return DeliveryOutcome.AlreadyRelayedForAnotherRecipient;
        }
        return _runAttributedEntry(courier, entryGas, messageIdentifier, deliversToThisRouter, _data, _signatures);
    }

    /**
     * @dev Whether the bridge has already relayed the message. Reads one flag
     * from the bridge and writes nothing.
     * @param messageIdentifier the identifier parsed from the message
     */
    function _isRelayedByBridge(bytes32 messageIdentifier) internal view returns (bool) {
        return _arbitraryMessageBridge().relayedMessages(messageIdentifier);
    }

    /**
     * @dev Holds the courier slot (`entryGas` in the low 96 bits, the courier
     * above) and records the message identifier as the
     * message the entry is handling, for the length of the dispatch. Both go
     * back to their idle values afterwards.
     * @param courier the address the caller names to earn the tip
     * @param entryGas the gas left when the entry started, which the gas-mode
     * tip measures from
     * @param messageIdentifier the identifier parsed from `_data`
     * @param deliversToThisRouter whether the message delivers to this router
     * (see {_deliversToThisRouter})
     * @param _data the signed message
     * @param _signatures the validator signatures over the message
     * @return outcome what the dispatch did
     */
    function _runAttributedEntry(
        address courier,
        uint256 entryGas,
        bytes32 messageIdentifier,
        bool deliversToThisRouter,
        bytes calldata _data,
        bytes calldata _signatures
    )
        internal
        nonReentrantUint256(COURIER_SLOT, uint256(uint96(entryGas)) | (uint256(uint160(courier)) << 96))
        returns (DeliveryOutcome outcome)
    {
        StorageSlot.getBytes32Slot(ENTRY_MESSAGE_SLOT).value = messageIdentifier;
        outcome = _dispatchEntryMessage(courier, messageIdentifier, deliversToThisRouter, _data, _signatures);
        StorageSlot.getBytes32Slot(ENTRY_MESSAGE_SLOT).value = _IDLE_ENTRY_MESSAGE;
    }

    /**
     * @dev The body of the single entry, run while the entry holds the courier
     * slot and records `messageIdentifier` as the message it is handling.
     * @param courier the address the caller names to earn the tip
     * @param messageIdentifier the identifier parsed from `_data`
     * @param deliversToThisRouter whether the message delivers to this router.
     * The entry has already returned for a relayed message for which this is
     * false, so a relayed message here always names this router.
     * @param _data the signed message
     * @param _signatures the validator signatures over the message
     * @return outcome {DeliveryOutcome.Delivered} for a fresh relay, otherwise
     * what the recovery returned
     */
    function _dispatchEntryMessage(
        address courier,
        bytes32 messageIdentifier,
        bool deliversToThisRouter,
        bytes calldata _data,
        bytes calldata _signatures
    ) internal returns (DeliveryOutcome outcome) {
        // One entry for every situation. A caller (the delivery service, or
        // anyone) always calls this function with the signed message. The branch
        // decides what the message needs:
        //
        //   - If the bridge has already relayed this message, a first delivery
        //     ran. The entry has already returned for a relayed message that
        //     does not deliver to this router, and for one this router already
        //     paid, so the only reason to be here is that the first delivery
        //     stranded. Finish it, paying the tip to the named courier only when
        //     that address is a courier. {_recover} re-checks everything, in
        //     its own order (that it is for this router, that it has not been
        //     paid, the two bridge flags, then the signatures): it returns
        //     {DeliveryOutcome.AlreadyHandled} for a message already paid, and
        //     reverts for any other fault.
        //
        //   - Otherwise this is a fresh delivery. The named address must be a
        //     courier (the existing protection against a stranger claiming the
        //     fee), and the message runs through the bridge, which calls back
        //     into {onTokenBridged}; that payout earns the tip because its live
        //     identifier is the one the entry recorded.
        IForeignArbitraryMessageBridge arbitraryMessageBridge = _arbitraryMessageBridge();
        bool courierIsListed = ICourierFilter(couriersFilter).isCourier(courier);
        if (arbitraryMessageBridge.relayedMessages(messageIdentifier)) {
            // Recovery is permissionless, but the tip is earned only by a listed
            // courier (the same gate the fresh delivery applies). A caller who
            // names a non-courier may still finish the delivery; clearing the
            // courier address leaves them no tip, so the shared distribution pays
            // the recipient in full. The entry gas stays in the low 96 bits, so
            // the slot stays above the guard's not-entered value and the entry's
            // reentrancy guard stays engaged for the rest of the call.
            if (!courierIsListed) {
                StorageSlot.Uint256Slot storage courierSlot = StorageSlot.getUint256Slot(COURIER_SLOT);
                courierSlot.value = uint256(uint96(courierSlot.value));
            }
            return _recoverWithReentrancyGuard(_data, _signatures);
        }
        if (!courierIsListed) {
            revert NotACourier(courier);
        }
        IBasicForeignAMB(address(arbitraryMessageBridge)).safeExecuteSignaturesWithAutoGasLimit(_data, _signatures);
        if (deliversToThisRouter && !processed[messageIdentifier]) {
            revert DeliveryNotCompleted(messageIdentifier);
        }
        return DeliveryOutcome.Delivered;
    }
    /**
     * @dev Points the courier check at another {ICourierFilter}. The router
     * starts as its own filter, answering from {isCourier}.
     */
    function setCouriersFilter(address _couriersFilter) external payable onlyOwner {
        // if this doesn't fail we are at least guaranteed that it has the method
        ICourierFilter(_couriersFilter).isCourier(address(0));
        couriersFilter = _couriersFilter;
    }
    /**
     * @dev Adds an address to, or removes it from, the router's own courier list.
     */
    function setCourierStatus(address _courier, bool _isCourier) external payable onlyOwner {
        isCourier[_courier] = _isCourier;
    }
}
