// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

interface IOmnibridge {
    function relayTokens(
        address _token,
        address _receiver,
        uint256 _value
    ) external;
    function relayTokensAndCall(
        address _token,
        address _receiver,
        uint256 _value,
        bytes calldata _data
    ) external;
}

interface IOmnibridgeExtra {
    function relayTokens(
        address _token,
        address _receiver,
        uint256 _value,
        address senderOrigin
    ) external;
    function relayTokensAndCall(
        address _token,
        address _receiver,
        uint256 _value,
        bytes calldata _data,
        address senderOrigin
    ) external;
}
