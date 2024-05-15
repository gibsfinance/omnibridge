// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import { IERC20Receiver } from "../interfaces/IERC20Receiver.sol";

contract StubMediator {
  address public immutable WETH;
  mapping(address => bool) public validators;
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
  function safeExecuteSignaturesWithAutoGasLimit(
    bytes calldata _data,
    bytes calldata _signatures
  ) external {
    IERC20Receiver(msg.sender).onTokenBridged(WETH, 1 ether, _data);
  }
}