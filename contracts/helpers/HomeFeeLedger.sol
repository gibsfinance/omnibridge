// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ReentrancyV2} from "./ReentrancyV2.sol";
import {IERC20Receiver} from "../interfaces/IERC20Receiver.sol";
import {IOmnibridge} from "../interfaces/IOmnibridge.sol";
import {IWETH as IWNative} from "../interfaces/IWETH.sol";

/**
 * @title InboundInstruction
 * @dev Decodes the `data` sent with an inbound transfer without ever reverting.
 * The only valid layout is `abi.encode(address recipient, uint256 partnerId, uint16 maximumTotalRate, bool unwrap)`.
 */
library InboundInstruction {
    /// @dev Exact byte length of a valid instruction: four 32 byte words.
    uint256 internal constant LENGTH = 128;

    /**
     * @dev Result of reading an instruction.
     * @param recipient the account that receives the tokens after fees.
     * @param partnerId the partner that earns a fee, or 0 for none.
     * @param maximumTotalRate the most the sender agrees to pay, in basis points.
     * @param unwrap true to pay the wrapped native token out as native coin.
     */
    struct Instruction {
        address recipient;
        uint256 partnerId;
        uint16 maximumTotalRate;
        bool unwrap;
    }

    /**
     * @dev Reads an instruction. Returns `valid` false when the length is wrong,
     * or when any word holds bits that its type cannot hold (a dirty word).
     * @param data the raw bytes passed by the mediator.
     * @return valid true when `data` is a well formed instruction.
     * @return instruction the decoded values, all zero when `valid` is false.
     */
    function read(bytes calldata data) internal pure returns (bool valid, Instruction memory instruction) {
        if (data.length != LENGTH) return (false, instruction);
        uint256 recipientWord = uint256(bytes32(data[0:32]));
        uint256 rateWord = uint256(bytes32(data[64:96]));
        uint256 unwrapWord = uint256(bytes32(data[96:128]));
        if (recipientWord > type(uint160).max) return (false, instruction);
        if (rateWord > type(uint16).max) return (false, instruction);
        if (unwrapWord > 1) return (false, instruction);
        instruction.recipient = address(uint160(recipientWord));
        instruction.partnerId = uint256(bytes32(data[32:64]));
        instruction.maximumTotalRate = uint16(rateWord);
        instruction.unwrap = unwrapWord == 1;
        return (true, instruction);
    }
}

/**
 * @title HomeFeeLedger
 * @dev Collects every bridge fee on the home side (PulseChain) in a ledger.
 * The fee is a gibs fee plus an optional partner fee. The partner fee is added to the gibs fee.
 * Fees are never sent out when they are earned. They are credited, and each owner withdraws.
 *
 * Outbound (home to foreign): `relay` and `relayNative` take the fee, then call a mediator. They may revert.
 * Inbound (foreign to home): a mediator delivers tokens to this contract and calls `onTokenBridged`.
 * The mediator ignores a failed callback, so after the caller check that function never reverts.
 * Anything it cannot place stays outside `totalOwed`, and the admin can rescue it with `rescueUnaccounted`.
 *
 * The admin sets the gibs rate (below a fixed ceiling) and can rescue unaccounted tokens.
 * The admin cannot touch the ledger, the collector, the mediator list, or any partner.
 */
contract HomeFeeLedger is ReentrancyV2, IERC20Receiver {
    using SafeERC20 for IERC20;

    /// @notice The base for every rate. 10_000 basis points is 100 percent.
    uint256 public constant BASIS_POINTS = 10_000;
    /// @notice The highest gibs rate in basis points. No function can raise it.
    uint16 public constant MAXIMUM_GIBS_RATE = 100;
    /// @notice The highest partner rate in basis points. No function can raise it.
    uint16 public constant MAXIMUM_PARTNER_RATE = 100;
    /// @notice The gas given to a native coin payout to an inbound recipient.
    uint256 public constant NATIVE_PAYOUT_GAS = 100_000;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    /**
     * @dev A registered partner.
     * @param payout the account credited with the partner fee.
     * @param rate the partner fee in basis points.
     * @param controller the account that may change this partner.
     * @param pendingController the account that may accept control, set by `transferPartnerControl`.
     */
    struct Partner {
        address payout;
        uint16 rate;
        address controller;
        address pendingController;
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

    /// @notice The wrapped native token (WPLS).
    IWNative public immutable wNative;
    /// @notice The account credited with every gibs fee. It cannot change.
    address public immutable gibsCollector;

    /// @notice The account that sets the gibs rate. Zero after `renounceAdmin`.
    address public admin;
    /// @notice The account that may accept the admin role.
    address public pendingAdmin;
    /// @notice The gibs fee in basis points.
    uint16 public gibsRate;
    /// @notice The number of partners registered. The first partner has id 1.
    uint256 public partnerCount;

    /// @notice True for a mediator that may deliver tokens and receive relays. Fixed at construction.
    mapping(address => bool) public isMediator;
    /// @notice The registered partners by id. Id 0 means no partner.
    mapping(uint256 => Partner) public partners;
    /// @notice What `account` can withdraw of `token`. The zero address as token means native coin.
    mapping(address => mapping(address => uint256)) public owed;
    /// @notice The sum of `owed` over all accounts for `token`.
    mapping(address => uint256) public totalOwed;

    error NotAdmin();
    error NotPendingAdmin();
    error NotPartnerController();
    error NotPendingPartnerController();
    error NotMediator();
    error ZeroAddress();
    error NoMediators();
    error RateTooHigh();
    error UnknownPartner();
    error RateAboveMaximum();
    error NothingToPay();
    error NothingReceived();
    error TransferFailed();
    error SenderNotWrappedNative();

    /// @notice Emitted once for each mediator allowed at construction.
    event MediatorAllowed(address indexed mediator);
    /// @notice Emitted when the gibs rate changes.
    event GibsRateSet(uint16 rate);
    /// @notice Emitted when an admin transfer starts.
    event AdminTransferStarted(address indexed admin, address indexed pendingAdmin);
    /// @notice Emitted when the admin role changes hands. The new admin is zero after a renounce.
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    /// @notice Emitted when a partner registers.
    event PartnerRegistered(uint256 indexed partnerId, address indexed controller, address payout, uint16 rate);
    /// @notice Emitted when a partner payout address changes.
    event PartnerPayoutSet(uint256 indexed partnerId, address payout);
    /// @notice Emitted when a partner rate changes.
    event PartnerRateSet(uint256 indexed partnerId, uint16 rate);
    /// @notice Emitted when a partner control transfer starts.
    event PartnerControlTransferStarted(uint256 indexed partnerId, address indexed pendingController);
    /// @notice Emitted when a partner control transfer completes.
    event PartnerControlTransferred(uint256 indexed partnerId, address indexed controller);
    /// @notice Emitted for each credit to the ledger. `reason` tells which fee or fallback it is.
    event Credited(address indexed token, address indexed account, uint256 amount, CreditReason reason);
    /// @notice Emitted when an account withdraws from the ledger.
    event Withdrawn(address indexed token, address indexed account, address indexed to, uint256 amount);
    /// @notice Emitted when the admin rescues unaccounted funds.
    event Rescued(address indexed token, address indexed to, uint256 amount);
    /// @notice Emitted when an outbound transfer is handed to a mediator.
    event Relayed(
        address indexed mediator,
        address indexed token,
        address indexed sender,
        address receiver,
        uint256 received,
        uint256 sent,
        uint256 partnerId
    );
    /// @notice Emitted when an inbound delivery is split and paid.
    event Delivered(
        address indexed mediator,
        address indexed token,
        address indexed recipient,
        uint256 value,
        uint256 available,
        uint256 paid,
        uint256 partnerId
    );
    /// @notice Emitted when an inbound delivery leaves tokens outside the ledger.
    event Skipped(address indexed mediator, address indexed token, uint256 value, SkipReason reason);

    /**
     * @dev Fixes the mediators, the wrapped native token and the collector. Sets the first rate and admin.
     * @param mediators the home mediators that may deliver tokens and receive relays. At least one.
     * @param _wNative the wrapped native token (WPLS).
     * @param _gibsCollector the account credited with gibs fees. It cannot change.
     * @param _admin the first admin.
     * @param initialGibsRate the first gibs rate in basis points, at most MAXIMUM_GIBS_RATE.
     */
    constructor(
        address[] memory mediators,
        IWNative _wNative,
        address _gibsCollector,
        address _admin,
        uint16 initialGibsRate
    ) {
        if (mediators.length == 0) revert NoMediators();
        if (address(_wNative) == address(0) || _gibsCollector == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }
        if (initialGibsRate > MAXIMUM_GIBS_RATE) revert RateTooHigh();
        for (uint256 index = 0; index < mediators.length; index++) {
            address mediator = mediators[index];
            if (mediator == address(0)) revert ZeroAddress();
            isMediator[mediator] = true;
            emit MediatorAllowed(mediator);
        }
        wNative = _wNative;
        gibsCollector = _gibsCollector;
        admin = _admin;
        gibsRate = initialGibsRate;
        reentrant = _NOT_ENTERED;
        emit GibsRateSet(initialGibsRate);
        emit AdminTransferred(address(0), _admin);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyPartnerController(uint256 partnerId) {
        if (msg.sender != partners[partnerId].controller) revert NotPartnerController();
        _;
    }

    /**
     * @dev Accepts native coin only from the wrapped native token, when it unwraps.
     */
    receive() external payable {
        if (msg.sender != address(wNative)) revert SenderNotWrappedNative();
    }

    // ---------------------------------------------------------------- admin

    /**
     * @notice Sets the gibs fee.
     * @param rate the new gibs rate in basis points, at most MAXIMUM_GIBS_RATE.
     */
    function setGibsRate(uint16 rate) external onlyAdmin {
        if (rate > MAXIMUM_GIBS_RATE) revert RateTooHigh();
        gibsRate = rate;
        emit GibsRateSet(rate);
    }

    /**
     * @notice Starts a transfer of the admin role. The new admin must call `acceptAdmin`.
     * @param newAdmin the proposed admin. Not the zero address.
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(msg.sender, newAdmin);
    }

    /**
     * @notice Completes a transfer of the admin role. Only the pending admin can call it.
     */
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    /**
     * @notice Gives up the admin role for good. The gibs rate and the rescue function then stay fixed.
     */
    function renounceAdmin() external onlyAdmin {
        emit AdminTransferred(msg.sender, address(0));
        admin = address(0);
        pendingAdmin = address(0);
    }

    /**
     * @notice Moves tokens that are not in the ledger. It never touches `totalOwed`.
     * Moves the whole difference between the balance and `totalOwed[token]`.
     * @param token the token to rescue, or the zero address for native coin.
     * @param to the receiver. Not the zero address.
     */
    function rescueUnaccounted(address token, address to) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = _balance(token);
        uint256 accounted = totalOwed[token];
        if (balance <= accounted) revert NothingToPay();
        uint256 amount = balance - accounted;
        emit Rescued(token, to, amount);
        _send(token, to, amount);
    }

    // ------------------------------------------------------------- partners

    /**
     * @notice Registers a partner. Anyone can register. The caller becomes the controller.
     * @param payout the account credited with the partner fee. Not the zero address.
     * @param rate the partner fee in basis points, at most MAXIMUM_PARTNER_RATE.
     * @return partnerId the new id. The first id is 1.
     */
    function registerPartner(address payout, uint16 rate) external returns (uint256 partnerId) {
        if (payout == address(0)) revert ZeroAddress();
        if (rate > MAXIMUM_PARTNER_RATE) revert RateTooHigh();
        partnerId = ++partnerCount;
        partners[partnerId] = Partner({payout: payout, rate: rate, controller: msg.sender, pendingController: address(0)});
        emit PartnerRegistered(partnerId, msg.sender, payout, rate);
    }

    /**
     * @notice Changes the account credited with a partner fee. Only the controller can call it.
     * @param partnerId the partner to change.
     * @param payout the new payout account. Not the zero address.
     */
    function setPartnerPayout(uint256 partnerId, address payout) external onlyPartnerController(partnerId) {
        if (payout == address(0)) revert ZeroAddress();
        partners[partnerId].payout = payout;
        emit PartnerPayoutSet(partnerId, payout);
    }

    /**
     * @notice Changes a partner fee. Only the controller can call it.
     * @param partnerId the partner to change.
     * @param rate the new rate in basis points, at most MAXIMUM_PARTNER_RATE.
     */
    function setPartnerRate(uint256 partnerId, uint16 rate) external onlyPartnerController(partnerId) {
        if (rate > MAXIMUM_PARTNER_RATE) revert RateTooHigh();
        partners[partnerId].rate = rate;
        emit PartnerRateSet(partnerId, rate);
    }

    /**
     * @notice Starts a transfer of partner control. The new controller must call `acceptPartnerControl`.
     * @param partnerId the partner to hand over.
     * @param newController the proposed controller. Not the zero address.
     */
    function transferPartnerControl(uint256 partnerId, address newController)
        external
        onlyPartnerController(partnerId)
    {
        if (newController == address(0)) revert ZeroAddress();
        partners[partnerId].pendingController = newController;
        emit PartnerControlTransferStarted(partnerId, newController);
    }

    /**
     * @notice Completes a transfer of partner control. Only the pending controller can call it.
     * @param partnerId the partner to take over.
     */
    function acceptPartnerControl(uint256 partnerId) external {
        Partner storage partner = partners[partnerId];
        if (msg.sender != partner.pendingController) revert NotPendingPartnerController();
        partner.controller = msg.sender;
        partner.pendingController = address(0);
        emit PartnerControlTransferred(partnerId, msg.sender);
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
     * Takes the gibs fee and the partner fee, then bridges the rest. Reverts on any problem.
     * The caller must approve this contract first. The amount counted is what arrives, not `amount`.
     * @param mediator an allowed home mediator.
     * @param token the token to send.
     * @param amount the amount to pull from the caller, before fees.
     * @param receiver the receiver on the foreign chain.
     * @param data passed to the mediator unchanged. It is not read here.
     * @param partnerId the partner that earns a fee, or 0 for none. An unknown id reverts.
     * @param maximumTotalRate the most the caller agrees to pay in basis points. A higher rate reverts.
     */
    function relay(
        address mediator,
        address token,
        uint256 amount,
        address receiver,
        bytes calldata data,
        uint256 partnerId,
        uint16 maximumTotalRate
    ) external nonReentrant {
        if (!isMediator[mediator]) revert NotMediator();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        _relay(mediator, token, received, receiver, data, partnerId, maximumTotalRate);
    }

    /**
     * @notice Wraps native coin and sends it from home to the foreign chain through an allowed mediator.
     * Takes the gibs fee and the partner fee, then bridges the rest. Reverts on any problem.
     * @param mediator an allowed home mediator.
     * @param receiver the receiver on the foreign chain.
     * @param data passed to the mediator unchanged. It is not read here.
     * @param partnerId the partner that earns a fee, or 0 for none. An unknown id reverts.
     * @param maximumTotalRate the most the caller agrees to pay in basis points. A higher rate reverts.
     */
    function relayNative(
        address mediator,
        address receiver,
        bytes calldata data,
        uint256 partnerId,
        uint16 maximumTotalRate
    ) external payable nonReentrant {
        if (!isMediator[mediator]) revert NotMediator();
        wNative.deposit{value: msg.value}();
        _relay(mediator, address(wNative), msg.value, receiver, data, partnerId, maximumTotalRate);
    }

    // -------------------------------------------------------------- inbound

    /**
     * @notice Called by a mediator after it delivers tokens to this contract.
     * After the caller check it never reverts, because the mediator ignores a failure and the tokens would be stranded.
     *
     * Order of work: read the balance that is not owed to anyone, take `available` as the smaller of that and `value`,
     * read the instruction, then split `available`.
     * If the instruction is malformed, the recipient is zero, or nothing is available, the tokens stay outside
     * `totalOwed` and `Skipped` is emitted. The admin can rescue them.
     * An unknown partner id counts as no partner.
     * If gibs rate plus partner rate is above the instruction's maximum, the excess is cut from the partner fee first,
     * then from the gibs fee.
     * Fees are credited to the ledger. The rest is paid to the recipient. If the payment fails for any reason,
     * the rest is credited to the recipient in the ledger. A failed native unwrap credits the wrapped token.
     * @param token the token the mediator delivered.
     * @param value the amount the mediator says it delivered.
     * @param data `abi.encode(address recipient, uint256 partnerId, uint16 maximumTotalRate, bool unwrap)`.
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

        Partner memory partner;
        if (instruction.partnerId != 0 && instruction.partnerId <= partnerCount) {
            partner = partners[instruction.partnerId];
        }
        (uint256 gibsFee, uint256 partnerFee) =
            _fees(available, gibsRate, partner.rate, instruction.maximumTotalRate);
        uint256 rest = available - gibsFee - partnerFee;
        _creditFees(token, gibsFee, partner.payout, partnerFee);
        if (rest > 0) _pay(token, instruction.recipient, rest, instruction.unwrap);
        emit Delivered(
            msg.sender, token, instruction.recipient, value, available, rest, instruction.partnerId
        );
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
     * @dev Splits `amount` into a gibs fee and a partner fee.
     * When the two rates add up to more than `maximumTotalRate`, the partner rate is cut first, then the gibs rate.
     */
    function _fees(uint256 amount, uint16 gibsRateNow, uint16 partnerRate, uint16 maximumTotalRate)
        internal
        pure
        returns (uint256 gibsFee, uint256 partnerFee)
    {
        uint256 gibsCharged = gibsRateNow;
        uint256 partnerCharged = partnerRate;
        uint256 excess = gibsCharged + partnerCharged > maximumTotalRate
            ? gibsCharged + partnerCharged - maximumTotalRate
            : 0;
        uint256 partnerCut = excess < partnerCharged ? excess : partnerCharged;
        partnerCharged -= partnerCut;
        gibsCharged -= excess - partnerCut;
        gibsFee = Math.mulDiv(amount, gibsCharged, BASIS_POINTS);
        partnerFee = Math.mulDiv(amount, partnerCharged, BASIS_POINTS);
    }

    function _creditFees(address token, uint256 gibsFee, address partnerPayout, uint256 partnerFee) internal {
        if (gibsFee > 0) {
            owed[token][gibsCollector] += gibsFee;
            emit Credited(token, gibsCollector, gibsFee, CreditReason.GibsFee);
        }
        if (partnerFee > 0) {
            owed[token][partnerPayout] += partnerFee;
            emit Credited(token, partnerPayout, partnerFee, CreditReason.PartnerFee);
        }
        totalOwed[token] += gibsFee + partnerFee;
    }

    /// @dev Pays the recipient. Credits the recipient in the ledger when the payment fails. Never reverts.
    function _pay(address token, address recipient, uint256 amount, bool unwrap) internal {
        bool paid = unwrap && token == address(wNative)
            ? _unwrapAndSend(recipient, amount)
            : _tryTransfer(token, recipient, amount);
        if (paid) return;
        owed[token][recipient] += amount;
        totalOwed[token] += amount;
        emit Credited(token, recipient, amount, CreditReason.FailedPayout);
    }

    /**
     * @dev Unwraps and sends native coin. Returns false with the wrapped tokens still held when it cannot.
     * When the send fails after the unwrap, the coin is wrapped again.
     * Should the wrap fail as well, the coin stays here outside the ledger and the admin can rescue it.
     */
    function _unwrapAndSend(address recipient, uint256 amount) internal returns (bool) {
        (bool unwrapped,) = address(wNative).call(abi.encodeCall(IWNative.withdraw, (amount)));
        if (!unwrapped) return false;
        (bool sent,) = recipient.call{gas: NATIVE_PAYOUT_GAS, value: amount}("");
        if (sent) return true;
        (bool wrapped,) = address(wNative).call{value: amount}(abi.encodeCall(IWNative.deposit, ()));
        if (wrapped) return false;
        // The coin is stuck and unaccounted. Count the recipient as paid so the wrapped token is not credited twice.
        return true;
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
        uint256 partnerId,
        uint16 maximumTotalRate
    ) internal {
        Partner memory partner;
        if (partnerId != 0) {
            if (partnerId > partnerCount) revert UnknownPartner();
            partner = partners[partnerId];
        }
        if (uint256(gibsRate) + partner.rate > maximumTotalRate) revert RateAboveMaximum();
        if (received == 0) revert NothingReceived();
        uint256 gibsFee = Math.mulDiv(received, gibsRate, BASIS_POINTS);
        uint256 partnerFee = Math.mulDiv(received, partner.rate, BASIS_POINTS);
        uint256 sent = received - gibsFee - partnerFee;
        if (sent == 0) revert NothingReceived();
        _creditFees(token, gibsFee, partner.payout, partnerFee);
        IERC20(token).forceApprove(mediator, sent);
        IOmnibridge(mediator).relayTokensAndCall(token, receiver, sent, data);
        if (IERC20(token).allowance(address(this), mediator) != 0) IERC20(token).forceApprove(mediator, 0);
        emit Relayed(mediator, token, msg.sender, receiver, received, sent, partnerId);
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
