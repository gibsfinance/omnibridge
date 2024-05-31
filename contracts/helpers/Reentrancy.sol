// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

abstract contract Reentrancy {
  error ReentrancyGuard();
  uint256 private constant ENTERED = 2;
  uint256 private constant NOT_ENTERED = 1;
  uint256 internal reentrant;
  uint256 internal reentrantUint256;

  modifier nonReentrant() {
    if (uint256(reentrant) > NOT_ENTERED) {
      revert ReentrancyGuard();
    }
    reentrant = ENTERED;
    _;
    reentrant = NOT_ENTERED;
  }
  modifier nonReentrantUint256(uint256 value) {
    if (reentrantUint256 > NOT_ENTERED) {
      revert ReentrancyGuard();
    }
    reentrantUint256 = value;
    _;
    reentrantUint256 = NOT_ENTERED;
  }
}
