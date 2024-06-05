// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import { StorageSlot } from "@openzeppelin/contracts/utils/StorageSlot.sol";

abstract contract ReentrancyV2 {
  error ReentrancyGuard();
  error InvalidValue();
  uint256 private constant _ENTERED = 2;
  uint256 private constant _NOT_ENTERED = 1;
  // global reentrant
  uint256 internal reentrant;

  modifier nonReentrant() {
    if (uint256(reentrant) > _NOT_ENTERED) {
      revert ReentrancyGuard();
    }
    reentrant = _ENTERED;
    _;
    reentrant = _NOT_ENTERED;
  }
  modifier nonReentrantUint256(bytes32 key, uint256 value) {
    if (value < _ENTERED) {
      revert InvalidValue();
    }
    StorageSlot.Uint256Slot storage slot = StorageSlot.getUint256Slot(key);
    if (slot.value > _NOT_ENTERED) {
      revert ReentrancyGuard();
    }
    slot.value = value;
    _;
    slot.value = _NOT_ENTERED;
  }
}
