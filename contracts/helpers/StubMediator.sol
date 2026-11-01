// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import { IERC20Receiver } from "../interfaces/IERC20Receiver.sol";

contract StubMediator {
  address public immutable WETH;
  address public token;
  mapping(address => bool) public validators;
  /// @dev Always false unless a test sets it, so the router takes the fresh delivery path.
  mapping(bytes32 => bool) public relayedMessages;
  /// @dev The identifier of the message being delivered, as the real bridge exposes it during delivery.
  bytes32 public messageId;
  constructor(address _weth) {
    WETH = _weth;
  }
  function exec(address to, bytes calldata b) external {
    (bool success, bytes memory res) = to.call(b);
    if (success) return;
    if (res.length == 0) revert();
    assembly {
      revert(add(32, res), mload(res))
    }
  }
  receive() external payable {}
  fallback() external payable {}
  function setToken(address _token) external {
    token = _token;
  }
  function bridgeContract() external view returns(address) {
    return address(this);
  }
  function validatorContract() external view returns(address) {
    return address(this);
  }
  function isValidator(address _addr) external view returns(bool) {
    return validators[_addr];
  }
  function setValidator(address _addr, bool _isValidator) external {
    validators[_addr] = _isValidator;
  }
  /**
   * @dev Stands in for the bridge's delivery call. Like the real bridge it receives a full
   * Arbitrary Message Bridge message. It reads the inner handle call out of the message and
   * hands the real token, value and fee director data to the caller's onTokenBridged.
   * While it does, messageId() returns the message's identifier, as the real bridge's does.
   * Layout: 32 id, 20 sender, 20 executor, 4 gas limit, 1 source length, 1 destination length,
   * 1 data type, the two chain ids, then selector + abi.encode(address,address,uint256,bytes).
   * Signatures are ignored.
   */
  function safeExecuteSignaturesWithAutoGasLimit(
    bytes calldata _message,
    bytes calldata
  ) external {
    uint256 innerStart = 79 + uint8(_message[76]) + uint8(_message[77]);
    (address bridgedToken,, uint256 value, bytes memory feeData) =
      abi.decode(_message[innerStart + 4:], (address, address, uint256, bytes));
    messageId = bytes32(_message[0:32]);
    IERC20Receiver(msg.sender).onTokenBridged(bridgedToken, value, feeData);
    messageId = bytes32(0);
  }
}
