// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import { StorageSlot } from "@openzeppelin/contracts/utils/StorageSlot.sol";

abstract contract TransientReentrancy {
  error ReentrancyGuard();
  bytes32 constant REENTRANCY_SLOT = keccak256(abi.encode("reentrancy.transient"));

  modifier nonReentrant() {
    StorageSlot.BooleanSlot storage slot = StorageSlot.getBooleanSlot(REENTRANCY_SLOT);
    if (slot.value) {
      revert ReentrancyGuard();
    }
    slot.value = true;
    _;
    slot.value = false;
  }
  modifier nonReentrantUint256(bytes32 key, uint256 value) {
    StorageSlot.Uint256Slot storage slot = StorageSlot.getUint256Slot(key);
    if (slot.value > 0) {
      revert ReentrancyGuard();
    }
    slot.value = value;
    _;
    slot.value = 0;
  }
}
