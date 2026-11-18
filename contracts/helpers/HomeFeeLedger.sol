// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ReentrancyV2} from "./ReentrancyV2.sol";
import {IERC20Receiver} from "../interfaces/IERC20Receiver.sol";
import {IOmnibridge} from "../interfaces/IOmnibridge.sol";
import {IWETH as IWNative} from "../interfaces/IWETH.sol";

/// @dev The base of every rate: 1e18 is 100 percent.
uint256 constant RATE_BASE = 1e18;

/**
 * @title InboundInstruction
 * @dev Decodes the `data` sent with an inbound transfer without ever reverting.
 * The only valid layout is
 * `abi.encode(address recipient, bool unwrap, uint256 feeRateE18, address partner, uint256 partnerRateE18)`.
 * The sender of the bridged transfer writes the fee, so the fee is part of what the sender signed.
 */
library InboundInstruction {
    /// @dev Exact byte length of a valid instruction: five 32 byte words.
    uint256 internal constant LENGTH = 160;

    /**
     * @dev Result of reading an instruction.
     * @param recipient the account that receives the tokens after fees.
     * @param unwrap true to pay the wrapped native token out as native coin.
     * @param feeRateE18 the gibs fee (1e18 is 100 percent).
     * @param partner the account that earns the partner fee, or zero for none.
     * @param partnerRateE18 the partner fee (1e18 is 100 percent). The two rates add up to at most 1e18.
     * It is zero when `partner` is the zero address.
     */
    struct Instruction {
        address recipient;
        bool unwrap;
        uint256 feeRateE18;
        address partner;
        uint256 partnerRateE18;
    }

    /**
     * @dev True when no partner fee is charged without a partner, and the two fees add up to at most 1e18
     * (100 percent), so they never take more than arrived. Each rate is checked against 1e18 before the
     * sum is compared, so the check cannot overflow.
     * @param feeRateE18 the gibs fee (1e18 is 100 percent).
     * @param partner the partner account, or zero.
     * @param partnerRateE18 the partner fee (1e18 is 100 percent).
     */
    function feesAreValid(uint256 feeRateE18, address partner, uint256 partnerRateE18)
        internal
        pure
        returns (bool)
    {
        if (partner == address(0) && partnerRateE18 != 0) return false;
        if (feeRateE18 > RATE_BASE) return false;
        return partnerRateE18 <= RATE_BASE - feeRateE18;
    }

    /**
     * @dev Reads an instruction. Returns `valid` false when the length is wrong,
     * when any word holds bits that its type cannot hold (a dirty word), or when the fees are not valid.
     * @param data the raw bytes passed by the mediator.
     * @return valid true when `data` is a well formed instruction.
     * @return instruction the decoded values, all zero when `valid` is false.
     */
    function read(bytes calldata data) internal pure returns (bool valid, Instruction memory instruction) {
        if (data.length != LENGTH) return (false, instruction);
        uint256 recipientWord = uint256(bytes32(data[0:32]));
        uint256 unwrapWord = uint256(bytes32(data[32:64]));
        uint256 feeWord = uint256(bytes32(data[64:96]));
        uint256 partnerWord = uint256(bytes32(data[96:128]));
        uint256 partnerRateWord = uint256(bytes32(data[128:160]));
        if (recipientWord > type(uint160).max || partnerWord > type(uint160).max) return (false, instruction);
        if (unwrapWord > 1) return (false, instruction);
        if (!feesAreValid(feeWord, address(uint160(partnerWord)), partnerRateWord)) return (false, instruction);
        instruction.recipient = address(uint160(recipientWord));
        instruction.unwrap = unwrapWord == 1;
        instruction.feeRateE18 = feeWord;
        instruction.partner = address(uint160(partnerWord));
        instruction.partnerRateE18 = partnerRateWord;
        return (true, instruction);
    }
}

/**
 * @title HomeFeeLedger
 * @dev Collects every bridge fee on the home side (PulseChain) in a ledger.
 * The fee is a gibs fee plus an optional partner fee. The partner fee is added to the gibs fee.
 * Fees are never sent out when they are earned. They are credited, and each owner withdraws.
 *
 * There is no admin. Nothing here can be set after construction. The fee is not stored in this contract:
 * the sender of each transfer writes the fee rates into the transfer data. The rates are taken as written.
 * The only limit is that the gibs fee and the partner fee add up to at most 100 percent (1e18),
 * because the fees cannot be larger than what arrived.
 * A sender can only write the fee for its own tokens, because the data travels with that transfer only.
 *
 * Outbound (home to foreign): `relay` and `relayNative` take the fee the caller names, then call a mediator.
 * They may revert.
 * Inbound (foreign to home): a mediator delivers tokens to this contract and calls `onTokenBridged`.
 * The mediator ignores a failed callback, so after the caller check that function never reverts.
 * Anything it cannot place stays outside `totalOwed`. Anyone can send it to `rescueRecipient` with
 * `rescueUnaccounted`. The recipient is fixed at construction, so no key chooses where rescued tokens go.
 */
contract HomeFeeLedger is ReentrancyV2, IERC20Receiver {
    using SafeERC20 for IERC20;

    /// @notice The gas given to a native coin payout to an inbound recipient.
    uint256 public constant NATIVE_PAYOUT_GAS = 100_000;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    /**
     * @dev The fee a caller of `relay` or `relayNative` agrees to.
     * @param feeRateE18 the gibs fee (1e18 is 100 percent).
     * @param partner the account credited with the partner fee, or zero for none.
     * @param partnerRateE18 the partner fee (1e18 is 100 percent). The two rates add up to at most 1e18.
     */
    struct FeeTerms {
        uint256 feeRateE18;
        address partner;
        uint256 partnerRateE18;
    }

    /// @dev Why `onTokenBridged` left tokens outside the ledger.
    enum SkipReason {
        MalformedData,
        ZeroRecipient,
        NothingAvailable,
        Reentrant
    }

    /// @dev What a ledger credit is for.
    enum CreditReason {
        GibsFee,
        PartnerFee,
        FailedPayout
    }

    /// @dev How a payout to a recipient is made. `UnwrappedNative` only applies to the wrapped native token.
    enum PayoutForm {
        Token,
        UnwrappedNative
    }

    /// @notice The wrapped native token (WPLS).
    IWNative public immutable wNative;
    /// @notice The account credited with every gibs fee. It cannot change.
    address public immutable gibsCollector;
    /// @notice The only account that `rescueUnaccounted` pays. It cannot change.
    /// It is separate from `gibsCollector`, so rescued tokens never mix with fee accounting.
    address public immutable rescueRecipient;

    /// @notice True for a mediator that may deliver tokens and receive relays. Fixed at construction.
    mapping(address => bool) public isMediator;
    /// @notice What `account` can withdraw of `token`. The zero address as token means native coin.
    mapping(address => mapping(address => uint256)) public owed;
    /// @notice The sum of `owed` over all accounts for `token`.
    mapping(address => uint256) public totalOwed;

    error NotMediator();
    error ZeroAddress();
    error NoMediators();
    error InvalidFees();
    error NothingToPay();
    error NothingReceived();
    error TransferFailed();
    error SenderNotWrappedNative();

    /// @notice Emitted once for each mediator allowed at construction.
    event MediatorAllowed(address indexed mediator);
    /// @notice Emitted for each credit to the ledger. `reason` tells which fee or fallback it is.
    event Credited(address indexed token, address indexed account, uint256 amount, CreditReason reason);
    /// @notice Emitted when an account withdraws from the ledger.
    event Withdrawn(address indexed token, address indexed account, address indexed to, uint256 amount);
    /// @notice Emitted when unaccounted funds are sent to `rescueRecipient`. `to` is always `rescueRecipient`.
    event Rescued(address indexed token, address indexed to, uint256 amount);
    /// @notice Emitted when an outbound transfer is handed to a mediator.
    event Relayed(
        address indexed mediator,
        address indexed token,
        address indexed sender,
        address receiver,
        uint256 received,
        uint256 sent,
        address partner
    );
    /// @notice Emitted when an inbound delivery is split. `toRecipient` is the amount meant for the recipient,
    /// before any failed payout. A failed payout is credited in the ledger, so `toRecipient` is not always paid.
    event Delivered(
        address indexed mediator,
        address indexed token,
        address indexed recipient,
        uint256 value,
        uint256 available,
        uint256 toRecipient,
        address partner
    );
    /// @notice Emitted when an inbound delivery leaves tokens outside the ledger.
    event Skipped(address indexed mediator, address indexed token, uint256 value, SkipReason reason);

    /**
     * @dev Fixes the mediators, the wrapped native token, the collector and the rescue recipient.
     * @param mediators the home mediators that may deliver tokens and receive relays. At least one.
     * @param _wNative the wrapped native token (WPLS).
     * @param _gibsCollector the account credited with gibs fees. It cannot change.
     * @param _rescueRecipient the only account that receives rescued tokens. It cannot change.
     */
    constructor(address[] memory mediators, IWNative _wNative, address _gibsCollector, address _rescueRecipient) {
        if (mediators.length == 0) revert NoMediators();
        if (address(_wNative) == address(0) || _gibsCollector == address(0) || _rescueRecipient == address(0)) {
            revert ZeroAddress();
        }
        for (uint256 index = 0; index < mediators.length; index++) {
            address mediator = mediators[index];
            if (mediator == address(0)) revert ZeroAddress();
            isMediator[mediator] = true;
            emit MediatorAllowed(mediator);
        }
        wNative = _wNative;
        gibsCollector = _gibsCollector;
        rescueRecipient = _rescueRecipient;
        reentrant = _NOT_ENTERED;
    }

    /**
     * @dev Accepts native coin only from the wrapped native token, when it unwraps.
     */
    receive() external payable {
        if (msg.sender != address(wNative)) revert SenderNotWrappedNative();
    }

    /**
     * @notice Sends tokens that are not in the ledger to `rescueRecipient`. It never touches `totalOwed`.
     * Sends the whole difference between the balance and `totalOwed[token]`.
     * Anyone can call it. The destination is fixed, so a caller gains nothing by calling it,
     * and the only effect of an early call is that the tokens arrive sooner.
     * @param token the token to rescue, or the zero address for native coin.
     */
    function rescueUnaccounted(address token) external nonReentrant {
        uint256 balance = _balance(token);
        uint256 accounted = totalOwed[token];
        if (balance <= accounted) revert NothingToPay();
        uint256 amount = balance - accounted;
        emit Rescued(token, rescueRecipient, amount);
        _send(token, rescueRecipient, amount);
    }

    // --------------------------------------------------------------- ledger

    /**
     * @notice Pays the caller everything the ledger owes the caller in `token`.
     * @param token the token, or the zero address for native coin.
     */
    function withdraw(address token) external nonReentrant {
        _withdraw(token, msg.sender);
    }

    /**
     * @notice Pays the caller's balance in `token` to another account.
     * @param token the token, or the zero address for native coin.
     * @param to the receiver. Not the zero address.
     */
    function withdrawTo(address token, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _withdraw(token, to);
    }

    // ------------------------------------------------------------- outbound

    /**
     * @notice Sends tokens from home to the foreign chain through an allowed mediator.
     * Takes the gibs fee and the partner fee the caller names, then bridges the rest. Reverts on any problem.
     * The caller must approve this contract first. The amount counted is what arrives, not `amount`.
     * @param mediator an allowed home mediator.
     * @param token the token to send.
     * @param amount the amount to pull from the caller, before fees.
     * @param receiver the receiver on the foreign chain.
     * @param data passed to the mediator unchanged. It is not read here.
     * @param terms the fee the caller pays. Fees that add up to more than 100 percent, or a partner rate with no partner, revert.
     */
    function relay(
        address mediator,
        address token,
        uint256 amount,
        address receiver,
        bytes calldata data,
        FeeTerms calldata terms
    ) external nonReentrant {
        if (!isMediator[mediator]) revert NotMediator();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        _relay(mediator, token, received, receiver, data, terms);
    }

    /**
     * @notice Wraps native coin and sends it from home to the foreign chain through an allowed mediator.
     * Takes the gibs fee and the partner fee the caller names, then bridges the rest. Reverts on any problem.
     * @param mediator an allowed home mediator.
     * @param receiver the receiver on the foreign chain.
     * @param data passed to the mediator unchanged. It is not read here.
     * @param terms the fee the caller pays. Fees that add up to more than 100 percent, or a partner rate with no partner, revert.
     */
    function relayNative(address mediator, address receiver, bytes calldata data, FeeTerms calldata terms)
        external
        payable
        nonReentrant
    {
        if (!isMediator[mediator]) revert NotMediator();
        wNative.deposit{value: msg.value}();
        _relay(mediator, address(wNative), msg.value, receiver, data, terms);
    }

    // -------------------------------------------------------------- inbound

    /**
     * @notice Called by a mediator after it delivers tokens to this contract.
     * After the caller check it never reverts, because the mediator ignores a failure and the tokens would be stranded.
     *
     * Order of work: read the balance that is not owed to anyone, take `available` as the smaller of that and `value`,
     * read the instruction, then split `available`.
     * If the instruction is malformed (this includes fees that add up to more than 100 percent, or a partner rate with no partner),
     * the recipient is zero, or nothing is available, the tokens stay outside `totalOwed` and `Skipped` is emitted.
     * Anyone can then send them to the fixed rescue recipient with `rescueUnaccounted`.
     * The gibs fee is `available` times the fee rate, rounded down. The partner fee is `available` times the
     * partner rate, rounded down. Both are credited to the ledger. The rest is paid to the recipient.
     * If the payment fails for any reason, the rest is credited to the recipient in the ledger.
     * A failed native payment credits the wrapped token, or native coin when the coin could be neither sent nor re-wrapped.
     * @param token the token the mediator delivered.
     * @param value the amount the mediator says it delivered.
     * @param data `abi.encode(address recipient, bool unwrap, uint256 feeRateE18, address partner, uint256 partnerRateE18)`.
     */
    function onTokenBridged(address token, uint256 value, bytes calldata data) external override {
        if (!isMediator[msg.sender]) revert NotMediator();
        if (reentrant == _ENTERED) {
            emit Skipped(msg.sender, token, value, SkipReason.Reentrant);
            return;
        }
        reentrant = _ENTERED;
        _deliver(token, value, data);
        reentrant = _NOT_ENTERED;
    }

    // ------------------------------------------------------------- internal

    function _deliver(address token, uint256 value, bytes calldata data) internal {
        (bool valid, InboundInstruction.Instruction memory instruction) = InboundInstruction.read(data);
        if (!valid) return _skip(token, value, SkipReason.MalformedData);
        if (instruction.recipient == address(0)) return _skip(token, value, SkipReason.ZeroRecipient);
        uint256 available = _available(token, value);
        if (available == 0) return _skip(token, value, SkipReason.NothingAvailable);

        uint256 gibsFee = Math.mulDiv(available, instruction.feeRateE18, RATE_BASE);
        uint256 partnerFee = Math.mulDiv(available, instruction.partnerRateE18, RATE_BASE);
        uint256 toRecipient = available - gibsFee - partnerFee;
        _creditFees(token, gibsFee, instruction.partner, partnerFee);
        if (toRecipient > 0) _pay(token, instruction.recipient, toRecipient, _payoutForm(token, instruction));
        emit Delivered(msg.sender, token, instruction.recipient, value, available, toRecipient, instruction.partner);
    }

    /**
     * @dev Native coin is only paid for the wrapped native token. Any other token is paid as itself.
     * @param token the token being delivered.
     * @param instruction the decoded instruction, whose `unwrap` flag asks for native coin.
     * @return form how the payout is made.
     */
    function _payoutForm(address token, InboundInstruction.Instruction memory instruction)
        internal
        view
        returns (PayoutForm form)
    {
        if (instruction.unwrap && token == address(wNative)) return PayoutForm.UnwrappedNative;
        return PayoutForm.Token;
    }

    function _skip(address token, uint256 value, SkipReason reason) internal {
        emit Skipped(msg.sender, token, value, reason);
    }

    /// @dev The smaller of `value` and the balance not owed to anyone. Zero when the balance cannot be read.
    function _available(address token, uint256 value) internal view returns (uint256) {
        (bool success, bytes memory result) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (address(this))));
        if (!success || result.length != 32) return 0;
        uint256 balance = abi.decode(result, (uint256));
        uint256 accounted = totalOwed[token];
        if (balance <= accounted) return 0;
        uint256 free = balance - accounted;
        return free < value ? free : value;
    }

    /**
     * @dev Credits the fees to their accounts. A fee of zero is not credited, so it emits no event.
     * @param token the token the fees are in.
     * @param gibsFee the gibs fee, credited to `gibsCollector`.
     * @param partner the partner account. Unused when `partnerFee` is zero.
     * @param partnerFee the partner fee, credited to `partner`.
     */
    function _creditFees(address token, uint256 gibsFee, address partner, uint256 partnerFee) internal {
        if (gibsFee > 0) _credit(token, gibsCollector, gibsFee, CreditReason.GibsFee);
        if (partnerFee > 0) _credit(token, partner, partnerFee, CreditReason.PartnerFee);
    }

    /**
     * @dev Adds `amount` to what `account` can withdraw of `token`, and to `totalOwed` for `token`.
     * The zero address as `token` means native coin.
     * @param token the token credited, or the zero address for native coin.
     * @param account the account that can withdraw the amount.
     * @param amount the amount credited.
     * @param reason what the credit is for, as emitted in `Credited`.
     */
    function _credit(address token, address account, uint256 amount, CreditReason reason) internal {
        owed[token][account] += amount;
        totalOwed[token] += amount;
        emit Credited(token, account, amount, reason);
    }

    /**
     * @dev Pays the recipient in the given form. When the payment fails, credits the recipient in the ledger
     * instead, in the token the coin is held in. Never reverts.
     * @param token the token being paid.
     * @param recipient the account to pay.
     * @param amount the amount to pay.
     * @param form whether to pay the token as it is, or as native coin.
     */
    function _pay(address token, address recipient, uint256 amount, PayoutForm form) internal {
        if (form == PayoutForm.UnwrappedNative) return _payUnwrapped(recipient, amount);
        if (_tryTransfer(token, recipient, amount)) return;
        _credit(token, recipient, amount, CreditReason.FailedPayout);
    }

    /**
     * @dev Unwraps the wrapped native token and sends the coin to the recipient. Never reverts.
     * The coin is held in one of three places, and the credit follows it:
     * the wrapped token when the unwrap fails, the native coin when the send fails and the wrap also fails,
     * and the wrapped token again when the send fails and the coin is wrapped back.
     * @param recipient the account to pay.
     * @param amount the amount to pay, in wrapped native tokens.
     */
    function _payUnwrapped(address recipient, uint256 amount) internal {
        (bool unwrapped,) = address(wNative).call(abi.encodeCall(IWNative.withdraw, (amount)));
        if (!unwrapped) {
            _credit(address(wNative), recipient, amount, CreditReason.FailedPayout);
            return;
        }
        (bool sent,) = recipient.call{gas: NATIVE_PAYOUT_GAS, value: amount}("");
        if (sent) return;
        (bool wrapped,) = address(wNative).call{value: amount}(abi.encodeCall(IWNative.deposit, ()));
        address heldToken = wrapped ? address(wNative) : address(0);
        _credit(heldToken, recipient, amount, CreditReason.FailedPayout);
    }

    /// @dev A token transfer that accepts tokens with no return value and never reverts or copies a long reply.
    function _tryTransfer(address token, address recipient, uint256 amount) internal returns (bool success) {
        bytes memory payload = abi.encodeCall(IERC20.transfer, (recipient, amount));
        uint256 replySize;
        uint256 reply;
        assembly ("memory-safe") {
            success := call(gas(), token, 0, add(payload, 0x20), mload(payload), 0, 0x20)
            replySize := returndatasize()
            reply := mload(0)
        }
        if (!success) return false;
        if (replySize == 0) return token.code.length > 0;
        return replySize >= 32 && reply == 1;
    }

    function _relay(
        address mediator,
        address token,
        uint256 received,
        address receiver,
        bytes calldata data,
        FeeTerms calldata terms
    ) internal {
        if (!InboundInstruction.feesAreValid(terms.feeRateE18, terms.partner, terms.partnerRateE18)) {
            revert InvalidFees();
        }
        if (received == 0) revert NothingReceived();
        uint256 gibsFee = Math.mulDiv(received, terms.feeRateE18, RATE_BASE);
        uint256 partnerFee = Math.mulDiv(received, terms.partnerRateE18, RATE_BASE);
        uint256 sent = received - gibsFee - partnerFee;
        if (sent == 0) revert NothingReceived();
        _creditFees(token, gibsFee, terms.partner, partnerFee);
        IERC20(token).forceApprove(mediator, sent);
        IOmnibridge(mediator).relayTokensAndCall(token, receiver, sent, data);
        if (IERC20(token).allowance(address(this), mediator) != 0) IERC20(token).forceApprove(mediator, 0);
        emit Relayed(mediator, token, msg.sender, receiver, received, sent, terms.partner);
    }

    function _withdraw(address token, address to) internal {
        uint256 amount = owed[token][msg.sender];
        if (amount == 0) revert NothingToPay();
        owed[token][msg.sender] = 0;
        totalOwed[token] -= amount;
        emit Withdrawn(token, msg.sender, to, amount);
        _send(token, to, amount);
    }

    /// @dev Sends native coin (token zero) or an ERC-20. Reverts on failure.
    function _send(address token, address to, uint256 amount) internal {
        if (token != address(0)) return IERC20(token).safeTransfer(to, amount);
        (bool success,) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    function _balance(address token) internal view returns (uint256) {
        if (token == address(0)) return address(this).balance;
        return IERC20(token).balanceOf(address(this));
    }
}
