// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import { IERC20Receiver } from "../interfaces/IERC20Receiver.sol";

contract StubMediator {
  address public immutable WETH;
  /// @dev Always false unless a test sets it, so the router takes the fresh delivery path.
  mapping(bytes32 => bool) public relayedMessages;
  /// @dev The identifier of the message being delivered, as the real bridge exposes it during delivery.
  bytes32 public messageId;
  /// @dev How many calls {exec} has made. Each call gets its own identifier from it.
  uint256 public execCount;
  constructor(address _weth) {
    WETH = _weth;
  }
  /**
   * @dev Calls `to` with `b` the way the live bridge runs a message: while the call runs,
   * messageId() returns a real, non-zero identifier, a fresh one for every call.
   * @param to the contract to call
   * @param b the calldata
   */
  function exec(address to, bytes calldata b) external {
    execCount += 1;
    execWithMessageId(to, b, keccak256(abi.encode("StubMediator.exec", execCount)));
  }
  /**
   * @dev Calls `to` with `b` while messageId() returns `identifier`, then clears it. A test passes
   * zero here to stand in for a bridge that reports no executing message, which the live bridge
   * never does during a callback. Bubbles up the callee's revert data.
   * @param to the contract to call
   * @param b the calldata
   * @param identifier the message identifier to report during the call
   */
  function execWithMessageId(address to, bytes calldata b, bytes32 identifier) public {
    messageId = identifier;
    (bool success, bytes memory res) = to.call(b);
    messageId = bytes32(0);
    if (success) return;
    if (res.length == 0) revert();
    assembly {
      revert(add(32, res), mload(res))
    }
  }
  receive() external payable {}
  fallback() external payable {}
  function bridgeContract() external view returns(address) {
    return address(this);
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
