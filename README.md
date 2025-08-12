# comar-ais-proxy
A script to proxy the AIS stream that the comar unit provide as websocket.

## How?

Script connects to the Comar AIS web UI to fetch a SID, then sets up a websocket connection.
It simulates the three-way-handshake that the browser does to get the stream.

This is then published at ``` :8080 ```

The script runs using node.js: ``` node proxy.js ```

Then you can publish it using a reversed proxy with a tool such as nginx, apache etc.

## Why?

Sometimes you want the data, but without exposing the comar unit...  this is one way.


## Requirements
Node.js and some modules: ``` axios ``` and ``` ws ```
optional: roxy software
