# zx402: Measurements

Fill this file during M0. It replaces the estimates in [SPEC.md](./SPEC.md) section 10.
Measurements from before the build are in [Before the build: the first measurements](#before-the-build-the-first-measurements).

## 1. Circuits

| Circuit | Constraints | Setup power | Proving time | Proving key size |
|---|---|---|---|---|
| `spend` | 16,828 | 15 | 1.5 to 1.9 s | 14,285,885 bytes |
| `insert` | 62,950 | 16 | 4.3 to 4.8 s | 47,067,202 bytes |
| `ragequit` | 8,423 | 14 | 1.0 s | 7,141,180 bytes |

The setup power is the smallest one that fits the circuit. snarkjs needs one row per constraint, one per public signal, and one more.
One shared powers of tau file of power 16 serves all three circuits. Its size is 113,248,170 bytes.
The proving key sizes are for the development keys.
Proving times were measured on an Apple M2 Max with Node 24.10.0 and snarkjs 0.7.6, while other builds ran. Each time covers the witness, the proof, and a check of the proof.

## 2. Scripts

| Script | Size in bytes | Size with parameters applied | Script hash |
|---|---|---|---|
| `pool` | 10,072 | 12,659 | |
| `deposit` | 484 | 518 | |
| `config` | 1,760 | 1,794 | |
| `asp` | 1,219 | 1,254 | |
| `nft` | 456 | 499 | |

Measured on 2026-10-06 with Aiken 1.1.24 and the development verification keys. The pool script takes the three verification keys as parameters, which adds about 2,600 bytes.
The pool script fits one publication transaction (limit 16,384 bytes). Its reference output locks 55.5 ADA at the current price per byte.
Script hashes depend on the deployment and are filled in after the live run.

## 3. Transactions on mainnet

| Transaction | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit | | | | | |
| Refund | | | | | |
| Insert, 1 deposit | | | | | |
| Insert, 1 note | | | | | |
| Insert, 4 slots | | | | | |
| Settle, 1 payout | | | | | |
| Settle, 4 payouts | | | | | |
| Ragequit | | | | | |
| Stealth leg 2 | | | | | |
| ASP update | | | | | |
| Config update | | | | | |

### Transactions on the local test chain

Measured on 2026-10-06 in `packages/txlib/test/flow.test.ts`, with the real validators, real proofs, and Preprod parameters.
Execution units include the 10 percent margin that the builders add. Sizes include signatures.

| Transaction | CPU steps | Memory units | Size in bytes | Fee in ADA |
|---|---|---|---|---|
| Deposit | none | none | 350 | 0.170781 |
| Refund | 9,549,351 | 30,049 | 478 | 0.186606 |
| Insert, 2 deposits | 3,561,283,645 | 1,062,749 | 990 | 0.714686 |
| Insert, 1 note | 2,882,288,665 | 775,150 | 885 | 0.636746 |
| Settle, 1 payout | 3,223,990,487 | 886,982 | 1,243 | 0.683587 |
| Settle, 4 payouts | 3,354,760,372 | 1,219,493 | 1,555 | 0.725929 |
| Ragequit | 2,854,798,448 | 676,089 | 1,312 | 0.647836 |
| Stealth leg 2 | none | none | 203 | 0.165961 |
| ASP update | 61,407,529 | 178,537 | 600 | 0.215321 |

So one private payment in stealth mode costs about 0.85 ADA in network fees for its two legs, before the relayer fee.

### Transactions on Preprod

The Preprod pool was deployed on 2026-10-06. Its record is [deployments/preprod.json](../deployments/preprod.json).

| Transaction | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Plain x402 payment, no pool | none | none | 281 | 0.169021 | `a185ee503b7a43e9faf67ea112f3adc05ffe3df5825b4b8512ad8d6a2c839a76` |
| Fund the role keys | none | none | 571 | 0.180549 | `b99438ad408efecccffc77e9cf866e4fd013ee165aa0fe0060fceda939a0ca42` |
| Publish the pool script | none | none | 12,947 | 0.725093 | `a9b1c5863c47a4bbf40448914192f893be139901a7f9c34c095f1073c89d1215` |
| Publish the deposit, config, and ASP scripts | none | none | 3,954 | 0.329401 | `0a57eac8b52fea26a1ebd71c82b34c0d1b91da824017a066a9389d45485dadbb` |
| Init | 34,513,558 | 107,826 | 1,439 | 0.227451 | `db87709baae198b5de44a8115b8f2a931fe0ca4d94142943615b7ba142ac523f` |
| Deposit | none | none | 349 | 0.170781 | `ea0c386124bc7a621850dbcc6604da672e9ea2f56244ea09d6582647e6a6380c` |
| Refund | 9,549,351 | 30,049 | 477 | 0.186606 | `6cc784d3785f8a41b44119f0cbd9016b16125f10f81dce35d175a0e98a6c6e58` |
| Insert, 1 deposit | 3,096,717,864 | 972,831 | 937 | 0.673714 | `8f6fa4b314995a5094a87ad5622fd2d85561d9305fdf946654cd8f567dfbc72f` |
| ASP update | 64,242,754 | 182,820 | 599 | 0.215772 | `4411baa60102d65d4d267469fdc7d24751278c2af79cc72cc95c68335058d1ff` |
| Settle, 1 payout to a one-time address | 3,224,181,642 | 887,490 | 1,242 | 0.683630 | `a65f39df751aa7843906799080d9520bbafb6a123e1730df354d9d06782632e4` |
| Stealth leg 2, one-time address to the seller | none | none | 196 | 0.165697 | `6043b7ec6e7fe3d98082081878ca66352ec0506405e36f1f9d33bce321bc9246` |
| Insert, 1 note | 2,887,382,131 | 792,574 | 884 | 0.638118 | `1e7c759350fef8ae0f4b74ce74eb34ad97057c7ac2b74c96ea25467fbfa571f0` |
| Ragequit | 2,864,233,950 | 699,948 | 1,174 | 0.643865 | `31e91180001495a39c500c4c29aba3a8d0bbe54237365ff41a7880ca760ec763` |

A deployment costs about 245 ADA: 160 ADA of role funding, 73.6 ADA locked in the four reference script outputs, 8.9 ADA in the three state outputs, and about 1.5 ADA of fees.
The Init units are the evaluated units before the 10 percent margin.

The first Init on Preprod was finished by hand, after the node refused it for a wrong script integrity hash.
That defect is fixed in `packages/txlib` (live cost models).
To prove the fix, the complete deploy function ran once more on Preprod on 2026-10-06 with the final code, as a rehearsal for mainnet.
All four transactions were accepted on the first try, and the run took 201 seconds.
That second pool is a rehearsal and is not recorded in this repository.

| Rehearsal transaction | Transaction hash |
|---|---|
| Fund the role keys | `8706c1a3537f111999d2fb6d1c3c67d418a187c0c63a3a14a10c3bc079199c6a` |
| Publish the pool script | `7be7af7699930f49b715e2f854f1a19a6a6e54524ef87c843ef762d6f1e285c0` |
| Publish the deposit, config, and ASP scripts | `7e2c0d74c0b838eb604c352ae782825486efa710ecf0f8ef664682f4bb665180` |
| Init | `7b156beead8160f683a932cb964d896bf5f7174f7a9decc56f04a6c5abcd7adc` |

The rows from Deposit to Ragequit are one complete pool story, run on 2026-10-06 with the code of this repository.
The indexer, the crank, the association set provider service and the relayer ran in one process against Blockfrost.
The sizes, fees and units in those rows are the values that the chain recorded.
A deposit of 10 ADA was credited as 9.7 ADA. A private payment of 2 ADA reached the seller from a one-time address.
The change note of 6.534303 ADA then left the pool through Ragequit.
For the same shape of transaction, the live units of Refund, Settle, Insert of 1 note and Ragequit are within 0.4 percent of the local test chain.
The association update is 5 percent higher on Preprod.
So one private payment in stealth mode cost 0.849327 ADA in network fees for its two legs, before the relayer fee of 1 ADA.

### The demo through the node and the stock x402 seller

On 2026-10-06 the node (`npm run node -w ops`), the example seller with the stock x402 server and facilitator, and the demo (`npm run demo -w ops`) ran as three processes against Preprod.
The demo ran four times with the same note store. All four runs ended with HTTP 200 and the weather body. Two later runs are at the end of this section.
The agent paid through the stock x402 client with the SDK's stealth signer. The stock facilitator checked and submitted the second leg.
The first and second run, between 15:44 and 15:57 UTC, used the first version of the node.
The third run, at 18:00 UTC, used the hardened SDK and the first node that skips work while nothing changes.
The fourth run, at 19:23 UTC, used the final code with the two latency fixes that section 4 describes.

| Transaction, first run | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit | none | none | 349 | 0.170781 | `188f2b64754228e1088f36cc68f63e35fca5b8cf42102791b8748471eefcd549` |
| Insert, 1 deposit | 3,245,199,950 | 989,153 | 1,007 | 0.688442 | `f96c4e1ce6c990704fe952fe3dd48839d7449d2f19b9941a9588533a154bca1d` |
| ASP update | 61,407,529 | 178,537 | 599 | 0.215321 | `c77106998cfd1b6f0aa00a04ad1476667566241e1d99b8021d1430b2a4cf2360` |
| Settle, 1 payout to a one-time address | 3,258,408,716 | 999,972 | 1,451 | 0.701784 | `860faa892eff5205f6e1e6d60615837926c6eeb719d338163499a8a0b28f151e` |
| Stealth leg 2, submitted by the stock facilitator | none | none | 202 | 0.165961 | `8295a36bb5111c94abc09d783552aac07ddd73769e5c9f42bca6b07f74fb39cf` |
| Insert, 1 note | 2,892,116,632 | 807,226 | 954 | 0.642385 | `9d25ba585f7eb9ef06162ce420808122c540a3af9a039ce28be1686ca97e1426` |
| Ragequit | 2,890,256,226 | 786,824 | 1,383 | 0.659950 | `3c9937b3ac020e23122c7d034640dd16afa13fd15242859818fbb1caf5020af4` |

| Transaction, second run | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit | none | none | 349 | 0.170781 | `15d64d2341f166cecb5aa70e65949cd3accad4dbd825d2c06a6ec287c7eb2903` |
| Insert, 1 deposit | 3,249,934,452 | 1,003,805 | 1,077 | 0.692708 | `9f36ba4c0f568f4596fe1478e66b8688699a6eba95fd6fe19533896431d29c07` |
| ASP update | 61,407,529 | 178,537 | 599 | 0.215321 | `dc50a6fd31020cc8fcdf42398d7f84c8e8547db02b82f474250a1f3e2fb66eb8` |
| Settle, 1 payout to a one-time address | 3,257,548,858 | 1,001,622 | 1,522 | 0.704941 | `fdf36cc2f51bdfd700df5dad651fe8c303807200df280b7e6659b81ec1a7d381` |
| Stealth leg 2, submitted by the stock facilitator | none | none | 202 | 0.165961 | `25232740f5bb6b297895e65184fd25cb55478752bd7885a5b4dd9f4c35c453d7` |
| Insert, 1 note | 2,899,686,358 | 826,161 | 1,025 | 0.647147 | `26c06f86d6d4b41d8a91b60d1b484ff360a9901d6e0e9a26362770d6e1d8a1c3` |
| Ragequit | 2,890,173,640 | 789,871 | 1,454 | 0.663244 | `051fd479d1a35b6310cfc5314de9d5323add552f097f845ea7f3ee7c750308d3` |

| Transaction, third run | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit | none | none | 349 | 0.170781 | `b262a1f060b453a514f83cf54f959d85a5b877c47e2f9d7a63ce53d2cb835140` |
| Insert, 1 deposit | 3,247,424,320 | 999,310 | 1,148 | 0.695392 | `62edd14aa40b41a8037344f1b05c2d629bb90ef5dddea26e1882af7d6ef055bd` |
| ASP update | 61,407,529 | 178,537 | 599 | 0.215321 | `f23b63ea87c93b93313c783eea9f8551cf28e9961a6ff6de80c20f61e1fd25ee` |
| Settle, 1 payout to a one-time address | 3,286,928,863 | 1,094,884 | 1,665 | 0.718733 | `e62a60a14378487166372dfa6efdc482569fe027b6541e92341a0026481f2a31` |
| Stealth leg 2, submitted by the stock facilitator | none | none | 202 | 0.165961 | `fb8f464241acae0d4832b16b05956f1f7d43231250f09db7025eda692ba0e90d` |
| Insert, 1 note | 2,904,420,859 | 840,813 | 1,095 | 0.651414 | `c1594dbabed5182ce55244235503baab17b82f21f983858acf033a043ab8049a` |
| Ragequit | 2,867,060,184 | 710,680 | 1,457 | 0.657140 | `660285f1a4163703d3d2d43b248069c3b46311f4189ad2f9573e91558e497bc1` |

| Transaction, fourth run | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit | none | none | 349 | 0.170781 | `e4b11f9e9d49263391cd49571694daaa09b2a3e7e975553aa936bd6009b9e6fb` |
| Insert, 1 deposit | 3,252,158,821 | 1,013,962 | 1,218 | 0.699659 | `e3f62b9280b0b049e41b9198bf57467876044b0bff9d649f88dde0b2eb2ad825` |
| ASP update | 61,407,529 | 178,537 | 599 | 0.215321 | `627a689b9679212e4cf30e56025d4b441075be1fd8cfe2b4fc844bd93e1f02cd` |
| Settle, 1 payout to a one-time address | 3,256,686,535 | 997,145 | 1,662 | 0.710781 | `fd2fd50d0979af7b04a99b0893342c5bb6ac52c8934e8470a20bb6786c722bf8` |
| Stealth leg 2, submitted by the stock facilitator | none | none | 202 | 0.165961 | `39f629f21208881635660ee62d972f2c2d91da2eadebca7d2c42aabb11df13b0` |
| Insert, 1 note | 2,909,155,361 | 855,465 | 1,165 | 0.655681 | `5093b3d3c8bca861c2cfa35f0ecdaf1be7c494bce20245f05154c4532d31e52f` |
| Ragequit | 2,887,421,393 | 788,990 | 1,666 | 0.672322 | `eaa3659b37a0534151e7131e809c86811dce7046e572dcbbd4301c4bcbbc7034` |

Pool transactions change in size as the pool ages, for two reasons.
Each Insert adds one root of 35 bytes to the root history in the pool datum, until the history holds its 16 roots.
A run makes two Inserts, so each kind of pool transaction is about 70 bytes larger in the next run.
A full history makes a pool transaction 525 bytes larger than in a new pool. The size alone then adds 0.0231 ADA to its fee.
The proof for a new nullifier also changes with the place of that nullifier in the trie.
It made a Settle or a Ragequit up to 139 bytes larger or smaller from one run to the next.

### Two runs after the comparison with Base

A comparison with the Base implementation then led to five fixes in the SDK and the relayer. Two more demo runs checked them on Preprod. Both ended with HTTP 200 and the weather body.

The fifth run, at 20:50 UTC on 2026-10-06, started without the demo's note store and with the same seed. Before the fix, that run would have used an old note secret again and locked its deposit.
The SDK found the four old deposits on chain. It took the fifth deposit secret and the fifth change secret, paid the seller and exited the change.
The sixth run, at 21:13 UTC, used the final code with all five fixes and the note store of the fifth run.

| Transaction, fifth run | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit | none | none | 349 | 0.170781 | `722906c19ba2caf5df038b9ca8a7bfa85f1113832e165ece38ad9f977878e1a3` |
| Insert, 1 deposit | 3,271,382,587 | 1,066,907 | 1,290 | 0.707268 | `48723b508932dd269e9e7a5602759245499c6148ad7e6a46b3bf7d10ebf8e583` |
| ASP update | 61,407,529 | 178,537 | 599 | 0.215321 | `b1a916d47182ffe574e8d65874796c3de5e37e8a03511675255da9accdfa2a3e` |
| Settle, 1 payout to a one-time address | 3,291,160,007 | 1,107,831 | 1,805 | 0.725945 | `fc6254b4deb6130161a842e7731309e8653239f04a18035aa8d0a16a26f4fe79` |
| Stealth leg 2, submitted by the stock facilitator | none | none | 202 | 0.165961 | `cb978fb4cf0e667cb4313056efed375433a1163b1a173ad595234cc7593320f4` |
| Insert, 1 note | 2,913,889,862 | 870,117 | 1,235 | 0.659948 | `8b19e41de203c49668fd8df7d4387bd70e73e8bbe8c479533eb87643b498159d` |
| Ragequit | 2,868,558,005 | 719,279 | 1,597 | 0.663904 | `e3b6b5c2744cf20d9f206b6a28f8d4f6fa0b4e4cd942dbda2eec621785a7e68d` |

| Transaction, sixth run | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit | none | none | 349 | 0.170781 | `b0401cb76ee30e1f7f736a4880594b40bc8335eb95523c6341e6433913a49996` |
| Insert, 1 deposit | 3,276,117,088 | 1,081,559 | 1,360 | 0.711534 | `bedb012c45c0cb8dd4b855126cd747bb9066b3da9f85075c82547a3daa299974` |
| ASP update | 61,407,529 | 178,537 | 599 | 0.215321 | `75ce39638f893d2a6b2beb09a720dd15300df6d0d509f867ab4d9bb5e01518c9` |
| Settle, 1 payout to a one-time address | 3,289,134,782 | 1,099,944 | 1,875 | 0.728424 | `8aa14376b07df1d1c5f1862c3981656e71451c0ecc0335606d7427302f463802` |
| Stealth leg 2, submitted by the stock facilitator | none | none | 202 | 0.165961 | `31ecb799a2ecf591030562aa79940d2cb74071bedaf1819c54fe6d617b0ea5ff` |
| Insert, 1 note | 2,915,789,138 | 880,486 | 1,305 | 0.663763 | `fcb2adb5066e8d76c434f22ef4abfed2cfe5ef788b70ccf628430b73698a5193` |
| Ragequit | 2,901,528,426 | 819,698 | 1,740 | 0.678367 | `e71971072dd46b50c2b600790d1bce87ee1b44b1eef3cf2b09a7288671e4b0b9` |

| Step, in seconds | Fifth run | Sixth run |
|---|---|---|
| Deposit submitted | 3.1 | 2.9 |
| Note spendable, from the start | 194.8 | 139.9 |
| First leg confirmed, from the payment request | 40.2 | 34.6 |
| Seller answered HTTP 200, from the payment request | 83.3 | 178.2 |
| Change note spendable, after the seller answered | 9.3 | 0.1 |
| Exit submitted, after the change was spendable | 9.6 | 9.7 |
| Exit confirmed, after the change was spendable | 23.3 | 19.9 |
| Whole demo | 310.6 | 338.0 |

During the fifth run the machine also ran two test suites that make proofs. So its time to a spendable note says nothing about the code.
In the sixth run Preprod made no block for 132 seconds after the block of the Settle. The payment to the seller entered the next block, so the seller answered after 178 seconds. The code did not cause that wait.
Since the fixes, a private payment makes two more requests to the agent's provider: one for the fee rate and one for the tip. A deposit through the SDK makes one sync first.

### The tUSDM pool

On 2026-10-07 the pool asset changed from ADA to tUSDM, the Preprod stablecoin of Masumi (policy `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde`, name `0014df10745553444d`, 6 decimals). The same validators and the same proving keys serve the new pool; only the asset parameter of the pool script changed. The deploy sent four transactions and took about four minutes.

| Deploy transaction | Transaction hash |
|---|---|
| Role funding | `6e525fdf46419f7c587a3a164a4fb55bb2319c9d82ed95961d365ef58af6679c` |
| Reference scripts 1 | `0200b471e4c1bc127566edc3521cc7dbca2f49fff95f5bee63b7184c613706a8` |
| Reference scripts 2 | `432ded4adfc56ad362858fe4ace3a73930c2cee593a7592cdc245d9983230391` |
| Pool, config and ASP outputs | `291d5501d4ffa0eb97b63197e4a0424b51c71149fb5979cd9730ccce5d6e0dd9` |

The pool ID is `d433ba1cc677f8771f22b0ecbbbdcda504022b96f34eeaed39fae78c`. The ADA pool from 2026-10-06 is retired; its record is in `deployments/retired/`.

The demo ran once against the tUSDM pool, at 03:44 UTC on 2026-10-07. It deposited 10 tUSDM, paid the seller 2 tUSDM through the stock x402 client, and exited the change of 7 tUSDM in public. It ended with HTTP 200 and the weather body.

| Transaction, tUSDM run | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit, 10 tUSDM plus 1.392130 ADA minimum | none | none | 445 | 0.175005 | `7618ba9a3b33ae70ae9c23bcf7f4f5635def0c77a1ffd81d5ac8583b9fd01e8d` |
| Insert, 1 deposit | 3,093,071,619 | 968,056 | 983 | 0.675770 | `3fe4adbde235b2d2657612666ac60229bcb3d3ae658cd8099d26e755285ff462` |
| ASP update | 61,407,529 | 178,537 | 599 | 0.215321 | `54290a18e7917be5d6aca5b71131f89852346841ff58dfd52b34bde3b18e6c84` |
| Settle, 1 payout of 2 tUSDM plus 2 ADA to a one-time address | 3,261,123,910 | 1,015,170 | 1,384 | 0.700479 | `ca9178e1f0768c05cef31f5f0565411190ce4b9d18ba25fb2e8d4140db9db5d7` |
| Leg 2, one-time address to the seller, submitted by the stock facilitator | none | none | 250 | 0.168073 | `0f848755cd9e3309c15ea1a5622d4db53fed1ecea3f60fef9fe890873cc419ec` |
| Insert, 1 change note | 2,900,511,156 | 833,523 | 930 | 0.644022 | `38f59cd274f4d1813744c8b2020d32ae175aa2f356c4d92789d71d3ece1942e3` |
| Ragequit, 7 tUSDM | 2,865,602,217 | 705,056 | 1,276 | 0.649316 | `fb038a0197d25aeea3890ab5ccc7a9a990736256e4f44366e1b7484fe28760a2` |

What the outputs show, read from the chain:

- The deposit output held 10 tUSDM and 1.392130 ADA, the measured minimum for that output. The Insert credited the whole 10 tUSDM, and the crank kept the deposit's ADA.
- The Settle left the pool with 7 tUSDM and its 6 ADA. The one-time address got exactly 2 tUSDM and 2 ADA. The relayer's change got 1 tUSDM, its fee, and the relayer paid the 2 ADA and the network fee from its own ADA.
- Leg 2 paid the seller 2 tUSDM and 1.831927 ADA, which is the attached 2 ADA minus the fee. No change output.
- The exit paid the user 7 tUSDM and 1.055950 ADA, which is the measured minimum. The pool ended with no token entry and its 6 ADA.

| Step, in seconds | tUSDM run |
|---|---|
| Deposit submitted | 3.2 |
| Note spendable, from the start | 139.1 |
| First leg confirmed, from the payment request | 30.6 |
| Seller answered HTTP 200, from the payment request | 75.9 |
| Change note spendable, after the seller answered | 24.2 |
| Exit submitted, after the change was spendable | 9.8 |
| Exit confirmed, after the change was spendable | 132.7 |
| Whole demo | 371.9 |

Block times: deposit 03:44:53, Insert 03:45:42, ASP update 03:46:44, Settle 03:47:16, seller payment 03:47:37, change Insert 03:48:08, exit 03:50:42 UTC. The exit waited 154 seconds for a block, which is the chain, not the code.

Costs of the tUSDM run for each party: the depositor paid 0.175 ADA of fee plus 1.392 ADA attached to the deposit, which the crank kept; the agent paid 1 tUSDM to the relayer and nothing in ADA for the payment; the relayer spent 0.700 ADA of fee plus the 2 ADA it attached, and earned 1 tUSDM; the seller received 2 tUSDM plus 1.832 ADA; the exit cost the user 0.649 ADA of fee plus 1.056 ADA attached to the exit output, which stays in the user's wallet.

### The zx402 pool

On 2026-10-07 the five protocol byte strings took the name zx402 (Spec 1.0.7). Labels, contexts, note secrets and role keys changed with them, so a new tUSDM pool was deployed at 07:08 UTC from the same proving keys. The tUSDM pool `d433ba1c…` from earlier that day is retired; its record is in `deployments/retired/`.

| Deploy transaction, zx402 pool | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|
| Role funding | 571 | 0.180549 | `9ca39e3ac8e4febf71093ec837ba2edec5811f8545e30d2bbc96bf2693d2ace7` |
| Reference scripts 1 | 12,985 | 0.726765 | `88b2f700b771a61982ecf8fba589efef718d87feb7fd20c711e9e86c32c51121` |
| Reference scripts 2 | 3,954 | 0.329401 | `9459d503655fe9685bcb13ea2f7f082ea4d949eedb4b9586bdab4f712f32e282` |
| Pool, config and ASP outputs | 1,435 | 0.227275 | `9f9509ea380c3db56b8c58c3a5e559bed290e717d07dab7e40acf127fe1dce09` |

The pool ID is `60279ebfb8db22bbe0cb2a1b7a61702ab36ade074a3866ac836df3ed`. The deploy cost 245.04 ADA, of which 160 ADA funded the roles.

The demo ran once against the zx402 pool, at 07:15 UTC on 2026-10-07, with the same steps as the tUSDM run: a deposit of 10 tUSDM, a payment of 2 tUSDM to the stock x402 seller, and a public exit of the 7 tUSDM change. It ended with HTTP 200 and the weather body after 350.9 seconds.

| Transaction, zx402 run | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit, 10 tUSDM plus the minimum ADA | none | none | 445 | 0.175005 | `9a8e6bbf33926dd61b4e0f569459ebfad084f4fded2255915b5467d9ebadd9dd` |
| Insert, 1 deposit | 3,113,944,857 | 1,028,131 | 985 | 0.680829 | `5c8c1f60bfdf3decc66172d7fb91bcfbf20511268369d0e9c831b5d53efe977e` |
| ASP update | 64,242,754 | 182,820 | 599 | 0.215772 | `288f63b6494a82ea3bc63138594a4fccf1d8bd7807b1f8de7d3767bf5cf2e335` |
| Settle, 1 payout of 2 tUSDM plus 2 ADA to a one-time address | 3,256,221,600 | 998,254 | 1,384 | 0.699149 | `9900d199882d60b84824bc12f422b6939296f5862bcb13e6f62252c46f654536` |
| Leg 2, one-time address to the seller, submitted by the stock facilitator | none | none | 250 | 0.168073 | `b430fb489db83360df792fa5aebbacf7cde7283608085fc028ff92f71dbffc91` |
| Insert, 1 change note | 2,897,675,931 | 829,240 | 930 | 0.643570 | `252de278de58ddc0b22dfb64346e4e54e9b40b2b607d7274493986889e926251` |
| Ragequit, 7 tUSDM | 2,865,145,514 | 703,384 | 1,276 | 0.649187 | `5f383fcb185108118a4b6429e64383081bcafba875b0838fd2c078d03358f655` |

The sizes equal the tUSDM run's, because the renamed strings keep their byte lengths. The execution units differ by less than one percent, which is the usual variation between runs with different inputs.

| Step, in seconds | zx402 run |
|---|---|
| Deposit submitted | 3.4 |
| Note spendable, from the start | 196.3 |
| First leg confirmed, from the payment request | 32.5 |
| Seller answered HTTP 200, from the payment request | 70.7 |
| Change note spendable, after the seller answered | 60.7 |
| Exit submitted, after the change was spendable | 9.6 |
| Exit confirmed, after the change was spendable | 23.2 |
| Whole demo | 350.9 |

Block times: deposit 07:15:15, Settle 07:18:26, seller payment 07:18:48, exit 07:20:32 UTC. The note waited 196 seconds to become spendable because the deposit's block, the Insert and the ASP update landed in three blocks 110 seconds apart, which is the chain, not the code.

### The staged demo: a pool funded earlier, one payment

On 2026-10-07 at 07:54 UTC the demo ran with `--reuse --no-exit` on the zx402 pool: no deposit, one private payment from a note already in the pool, and the change left inside for the next run. This is the shape of the owner's demo. The seller answered HTTP 200 after 96.6 seconds; the whole run took 99.7 seconds. The demo printed the explorer links, which the README repeats with screenshots from cexplorer (`docs/evidence/`).

| Transaction, staged run | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Settle, 1 payout of 2 tUSDM plus 2 ADA to a one-time address | see note | see note | 1,830 | 0.74 | `6439e9c5eec05c2692995ab17c7164be38e068003ec832e21c51a1b1e427be6a` |
| Leg 2, one-time address to the seller, submitted by the stock facilitator | none | none | 240 | 0.17 | `c493eeedb959bc091da233b0971bd1818faed68efca60ad324e263e3b5e57640` |

The sizes and fees are the explorer's rounded figures; the execution units of a Settle are the same as in the runs above, because the validator and the circuit did not change.

Three earlier attempts of the same staged run failed at leg 2 with "Blockfrost submitTx failed" from the seller's facilitator, while every run with a fresh deposit had worked. The cause was in our builder: the Conway set tag on the inputs of leg 2 was written only when a Mesh transaction builder had been constructed earlier in the same process, which a fresh-deposit run does and a `--reuse` run does not. The stock facilitator re-encodes every transaction with the tag before it submits, so the body hash changed and the node rejected the signature. Resubmitting the original bytes went through, which is how the cause was found. The builder now sets the tag itself (regression test TX-09). Those attempts left 2 tUSDM plus 2 ADA at each of three one-time addresses (indexes 1, 2 and 3), recoverable with the SDK's `recoverOneTimeFunds`; the one-time funds of index 3 were spent by the resubmission, which paid the seller once more.

### A Masumi agent paid from the pool

On 2026-10-07 at 07:22 UTC the pool paid a Masumi agent on Preprod: "Expose: Web Single Answer" (registry asset `7e8bdaf2…dbc77`, API `https://staging.kodosumi.io/sumi/web_single_answer_cc`), priced at 0.01 tUSDM in the pool's unit. Masumi agents are paid through a Masumi payment service node, which locks the price in Masumi's escrow contract from its own purchasing wallet. The command `npm run masumi -w ops` funded that wallet from the pool in private, started the job, created the purchase on a local Masumi node (payment source V1, the version every agent in the Preprod registry uses), and read the answer.

| Transaction, Masumi purchase | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit, 10 tUSDM | none | none | 445 | 0.175005 | `08864108b15e833ca9a3ea82bcc3d5cd701c1d87c545fd32347ec7a4e8fc7c66` |
| Settle, 1 payout of 0.01 tUSDM plus 2 ADA to the Masumi purchasing wallet | 3,290,328,268 | 1,110,449 | 1,691 | 0.721590 | `9d22cf8a3fd678be5019b11bc9bae450e751796e45acd972f970572b81ad3439` |
| Masumi escrow lock, submitted by the Masumi node from its purchasing wallet | none | none | 1,056 | 0.202065 | `21b0de05e35f0c1a5a8bd7dfadb666bc7fb4730fd2be2fc856d78eac328a0d6c` |

The run was split in two by a surprise: the agent's `start_job` answer carries no `amounts` field, which the first version of the command required. The first run deposited, paid the purchasing wallet (134 seconds to a spendable note, 188 seconds to the funded wallet) and stopped at the job start. The fixed command found the wallet already funded, started job `6ac5f4b82173c6fa74f8fe68` after 15 seconds and created the purchase after 18 seconds. The Masumi node batches escrow locks every four minutes, so the lock entered the chain after 372 seconds; the agent answered 1 second later, with a one-sentence answer and three cited sources.

The agent's seller never saw the pool. The purchasing wallet received its tUSDM from a Settle output, which looks like any other payout, and the escrow lock is a plain Masumi transaction from that wallet.

### Two clean Masumi purchases, one of them end to end

After the fixes above, the command ran twice more against the same agent on 2026-10-07. The first run (09:24 UTC) paid from a note already in the pool: Settle `0d90e8a6…`, escrow lock `c078b060…` after 302 seconds, job `6ac61036…` completed. The second run (09:31 UTC) started with `--deposit`, so one command shows the whole trail: deposit, private payment, escrow lock, answer. It is Demo 2 in the README, with the terminal log in `docs/evidence/masumi-demo-2026-10-07.log` and cexplorer screenshots in `docs/evidence/masumi-*.png`.

| Transaction, end-to-end Masumi run | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit, 10 tUSDM | none | none | 445 | 0.175005 | `87f5283ea9541ff6f563f20b817864bd5683c12f13fe561a2dc8ed9f9895dad0` |
| Settle, 1 payout of 0.01 tUSDM plus 2 ADA to the Masumi purchasing wallet | 3,309,382,630 | 1,164,809 | 2,042 | 0.741544 | `69c4014661a252ee35dd9cdf4f08d1a8b4799a6af7ac6767ef4f2a4b3ffb4144` |
| Masumi escrow lock, submitted by the Masumi node from its purchasing wallet | none | none | 1,056 | 0.202065 | `0b2d5095d6f04804c7de5663deec89c8c39559a0a214a70968190ab172a0c2c2` |

| Step, in seconds | end-to-end run |
|---|---|
| Deposit submitted | 6.9 |
| Note spendable, from the start | 144.1 |
| Settle submitted | 155.3 |
| Purchasing wallet funded | 233.9 |
| Escrow FundsLocked (the node batches locks every four minutes) | 515.8 |
| Job completed, answer received | 517.2 |

The Settle spent one of the pool's notes; the chain cannot tell which, and the fresh deposit of this run is one of several candidates. The agent's answer, one sentence with three cited sources, came back through the Masumi job status.

### Admin transactions on Preprod

Run on 2026-10-06 on the rehearsal pool with `ops/src/admin.ts`.

| Transaction | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Config update, pause deposits | 82,889,536 | 236,548 | 737 | 0.234389 | `462a3a1c32b1c2c46b7de4dfe5855c39fd9925d3a4c81b21ecf47eebc871c437` |
| Config update, unpause deposits | 82,889,536 | 236,548 | 737 | 0.234389 | `b8bca7aac78b8a24baa865e50d34ae22852639e38194abd9ff29c43d07ab2986` |
| Sweep of 4 reference script outputs | none | none | 508 | 0.421152 | `1b7e85e2798319cdd4b54efa8aa09a1819f5b23c8c6fef9c6a9fac3e0a108c52` |

The sweep returned 73.55015 ADA to the operator. Its fee is higher than a plain payment because the ledger charges for the bytes of every reference script on a spent input.

## 4. End-to-end timings

| Flow | Time from request to one confirmation |
|---|---|
| Stealth payment, one-time key funded on demand | 116.0 s, 110.2 s, 68.8 s and 78.2 s on Preprod, four runs |
| Stealth payment, one-time key funded ahead | not built in M0 |

The time runs from the request to the seller until the seller answers HTTP 200.
It covers the proof, the settlement by the relayer, one confirmation of the first leg, the second leg, and its check and one confirmation by the stock facilitator.

### The demo on Preprod, step by step

The four runs of the demo command from section 3. Times are in seconds.

| Step | First run | Second run | Third run | Fourth run |
|---|---|---|---|---|
| Deposit submitted | 3.6 | 2.9 | 3.0 | 2.8 |
| Note spendable, from the start | 119.0 | 163.7 | 231.0 | 91.1 |
| First leg confirmed, from the payment request | 28.9 | 26.9 | 30.1 | 40.3 |
| Seller answered HTTP 200, from the payment request | 116.0 | 110.2 | 68.8 | 78.2 |
| Change note spendable, after the seller answered | 0.0 | 6.1 | 54.8 | 15.3 |
| Exit submitted, after the change was spendable | 9.0 | 9.0 | 8.5 | 10.4 |
| Exit confirmed, after the change was spendable | 19.5 | 75.0 | 41.6 | 21.0 |
| Whole demo | 254.5 | 355.0 | 396.2 | 205.5 |

Waiting for blocks dominates every step. The longest single wait, 75 seconds for the exit of the second run, was one slow block.

The third run was slow up to the spendable note. Two things in the node of that run caused it.
The crank repeated an idle step only after 60 seconds, so it submitted the Insert 98 seconds after the block of the deposit.
The indexer read each new block once. Right after the block of the association update, the provider still served the old association output.
The next block came 67 seconds later, so the note became spendable 82 seconds after the block of the update.
The final code repeats an idle step after 20 seconds. While the pool is active, its indexer reads each new block a second time 5 seconds later.
In the fourth run the crank submitted the Insert 33 seconds after the block of the deposit.
The note became spendable 13 seconds after the block of the association update.

In the first and second run the payment to the seller entered the second block after the Settle. In the third and fourth run it entered the next block.
Four runs are too few to say whether the code or the block times made that difference.

### Provider requests of the node

In the third and fourth run the node counted its HTTP requests to Blockfrost. The pool had about 20 transactions.

| What | Requests |
|---|---|
| Start of the node with a history of 13 pool transactions | 28 |
| Start of the node with a history of 17 pool transactions | 33 |
| Round that finds no new block | 1 |
| Round after a new block | 8 |
| One minute in which the node submitted nothing, seven samples | 12 to 27 |
| Each of the first three minutes of the fourth run | 74, 96 and 43 |
| Third run: 11.5 minutes of node time with one demo | 392 |
| Fourth run: 4 minutes of node time with one demo | 282 |

A round comes every 10 seconds, and Preprod makes about three blocks a minute.
That gives 27 requests a minute for a node that submits nothing, or about 1,600 an hour.
The seven measured minutes average 19 requests, or about 1,100 an hour, because they had fewer blocks.
For two minutes after a change, the second read of each new block adds 7 requests per block.
A read of the history costs one more request for every 100 transactions at the pool address and at the deposit address.
The demo and the seller's facilitator make their own requests. This count does not include them.

### Step timings on Preprod

One sample each, from the pool story in section 3, run step by step on a laptop that was busy with other work.
Preprod makes a block about every 20 seconds.

| Step | Work before submission | Wait for one confirmation |
|---|---|---|
| Deposit | 1.8 s to build | 27.8 s |
| Insert of 1 deposit by the crank | 14.3 s to read, prove, build and submit | 33.8 s |
| Association update | 6.3 s to read, build and submit | 49.1 s |
| Private settlement by the relayer | 1.9 s to prove, 7.0 s to verify, build and submit | 27.6 s |
| Stealth leg 2 | under 1 s to build | 39.4 s |
| Insert of 1 note by the crank | 19.3 s to read, prove, build and submit | 22.7 s |
| Ragequit | 4.2 s to prove, 5.6 s to build | 33.1 s |

From the block of the deposit to the block of the second stealth leg, 224 seconds passed.
That covers the deposit, its insertion, its approval, the private settlement and the payment to the seller, each started by hand after the previous one confirmed.
An indexer that starts cold replayed this history of five pool transactions in about 10 seconds.

### Relayer chaining on Preprod, 2026-10-19

The node can chain pool transactions: a Settle builds on the pool output of a Settle that is still pending (SPEC 8.2, `ZX402_MAX_PENDING`).
The burst command (`npm run burst -w ops -- --count 5`) starts five private payments at the same moment, each from its own note, and reports where they land.
Every run used the zx402 pool `60279ebf…f3ed`, a token pool in tUSDM, through Blockfrost.

#### The result

The fair comparison is runs 4 and 5: the same code, with chaining on and off.

| Run | `ZX402_MAX_PENDING` | Confirmed | Blocks | First to last payment block | Last confirmation after the start |
|---|---|---|---|---|---|
| 5 | 1 (off) | 5 of 5 | 5 blocks over 9 heights, 5310449 to 5310457 | 203 s (12:30:38 to 12:34:01 UTC) | 296 s |
| 4 | 4 (on) | 5 of 5 | 5 consecutive blocks, 5310398 to 5310402 | 84 s (12:14:45 to 12:16:09 UTC) | 141 s |

With chaining, the pool advanced in every block until the burst was done, and the last payment confirmed about 2.1 times sooner.
The payments still landed one per block, not several in one block. The relayer handles one Settle at a time, and each took about 18 seconds (all five were submitted within 91 seconds). That is close to one block time, so each block caught one Settle. Several Settles per block is the next step: the relayer must verify proofs and build in parallel.

#### What the runs before found

Runs 1a to 3 failed in ways that the local test chain could not show. Each failure led to a fix in this branch.

| Run | Setting | Result | Cause | Fix |
|---|---|---|---|---|
| 1a | off | 1 of 5 confirmed | The relayer had one ADA-only output. The first Settle spent it as a fee input, and its change holds the relayer's tUSDM fee, so no ADA-only output was left for collateral: `Payer needs an ADA-only collateral UTXO with at least 5 ADA` | The burst top-up keeps a dedicated 5 ADA collateral output (`relayerTopUp`, OPS-07) |
| 1 | off | 5 of 5, 5 blocks over 18 heights, 343 s | Blockfrost reported a Settle confirmed while its address view still listed the spent pool output. The next Settle built on it and was refused with `BadInputsUTxO`, and each payment lost 20 to 40 seconds to retries | The sequencer keeps a just-confirmed transaction in its view while the provider still lists an input it spent (SEQ-09) |
| 2 | on | 3 of 5, no payment chained | Every Settle built on a pending pool output failed evaluation with an empty `ScriptFailures` map. Mesh 1.9.1 `evaluateTx` drops the inline datum of each additional UTXO, so the evaluator saw the pool input without its datum | The Blockfrost adapter posts the additional UTXOs itself, with the datum (`ogmiosAdditionalUtxo`, TX-16) |
| 3 | on | 3 of 5 | Ogmios refused the request: `failed to decode payload from base64 or base16`. Blockfrost does not accept the dotted asset keys of the Ogmios v5.6 schema. Later, the relayer's ADA-only float ran out, and the coin selection spent the collateral output | Tokens nest by policy, as Mesh sends them. The top-up keeps an ADA-only float of 4 ADA per payment |

The datum fix was checked against the live evaluator directly. A confirmed Settle (`45a6f496…`), re-evaluated with its spent inputs as additional UTXOs, returns `spend:0` with 1,039,005 memory units and 3,000,484,104 CPU steps through the fixed adapter. Without the datum, the same request fails with the empty `ScriptFailures` map of run 2.

#### Every Settle

| Run | Block | Settle |
|---|---|---|
| 1 | 5310209 | `e7f76dfa2b3b639b2d83583bcb627e3a84c420964aff7dc87402e16dd552c2af` |
| 1 | 5310212 | `7a57772ffdfb853a004e2a24822f357bd4f3c8042a6044e7c380c7bea9779b1a` |
| 1 | 5310213 | `eb48395369216f09bae3e0767146bed95286306b48a8a42d8d991295cbf8fcdd` |
| 1 | 5310224 | `05b318c8a324233f7723879c04db8adb3df08d14b3db9c0c56e7b2ff2825dd41` |
| 1 | 5310226 | `acc627f94a7b09d417bc997acca2a1848be493e96f127c4e63c4b664d296f423` |
| 2 | 5310235 | `2268e697d6bf476982b0bfdea61b2d4e3153278aca71c125a2fa0c350eb2e043` |
| 2 | 5310237 | `829a93398152899c657343625364dd54a5b9a297a409bdcc53345e79e9b84c09` |
| 2 | 5310239 | `02432090cd9404e7642406a2a793665503026ac99ac42a4e1f7192de9b304327` |
| 3 | 5310354 | `d390a1105906bad5e3326d89f392a01cc18074251b879b640d2fab5cf26f164f` |
| 3 | 5310355 | `21a6e098988ed2013421268de901e38bf959e531573e23854258c09a076859e3` |
| 3 | 5310357 | `45a6f496f386b2c26faf65b5870d526c3c3543ec5d4e103024d1bd124650b5f8` |
| 4 | 5310398 | `54e7d52ba673e9e84874391f631f06ccacc8d4cab3f8b776e6d202e7806deb79` |
| 4 | 5310399 | `27d14061011f4b5707000fa500ad24a39f234562e4424079aa6ff5b19b692b1a` |
| 4 | 5310400 | `ae33af6bfd8919c4de5416258d3affc2caf07c8d7fe30a669202c0a7849301f0` |
| 4 | 5310401 | `541ddc98c667d00365962bb72c1786e406920fbd165c90d12b5a1a263db42018` |
| 4 | 5310402 | `8e9fe76502af4306fce8f749f98bb82f234c878703e8c59639b49c566ff51a9b` |
| 5 | 5310449 | `4ec2525e17fd4e2b3496440e0bbff83a34e8d4fe27c5e570d2276bf6dc4aa8cb` |
| 5 | 5310450 | `264869f1f74fc006aca8d2282c2da44006f8c3f1813ee2d7215a1da2a1a6c5ed` |
| 5 | 5310453 | `95fbbd424a53fcc14d1e4343b4266c33461baa2d38621b04b12e74b4c4bc28ff` |
| 5 | 5310455 | `942ad136467cab58f206dbb5b51b9ca542bb77c46c1c00fb8a1f0abb7ab22100` |
| 5 | 5310457 | `ab22bcb151ddbd9a0892bfa082f8c9ceaf8f85dde63ba037ce1a2125b29caa7d` |

The terminal output of each run and the node logs are in `docs/evidence/chaining-2026-10-19-*.log`.
`ZX402_MAX_PENDING` stays 1 by default until a run lands several payments in one block.

## 5. Differences from the Spec estimates

No estimate in SPEC section 10.3 was wrong by more than 20 percent.

| Transaction | Estimated CPU | Measured CPU | Estimated fee in ADA | Measured fee in ADA |
|---|---|---|---|---|
| Deposit | none | none | 0.17 to 0.20 | 0.170781 on Preprod |
| Insert, 4 notes | about 2.9B | 3.08B in the validator tests | 0.60 to 0.70 | 0.638118 for 1 note on Preprod |
| Insert, 4 deposits | about 4.1B | 4.26B in the validator tests | 0.75 to 0.90 | 0.714686 for 2 deposits on the local chain |
| Settle | about 2.9B | 3.22B on Preprod | 0.65 to 0.80 | 0.683630 on Preprod |
| Ragequit | about 2.6B | 2.86B on Preprod | 0.60 to 0.75 | 0.643865 on Preprod |
| Stealth leg 2 | none | none | 0.17 to 0.20 | 0.165697 on Preprod |

Settle and Ragequit use about 10 percent more CPU than estimated, and both stay under a third of the transaction limit.
The Spec estimated 1.0 to 1.2 ADA for one private payment in stealth mode, counting a quarter of an Insert.
The measured two legs cost 0.849327 ADA. A quarter of the Insert of one note adds 0.16 ADA, which gives 1.01 ADA.
When a change note is inserted alone, the whole Insert of 0.638118 ADA belongs to that payment, which gives 1.49 ADA.

## 6. Contract building blocks

Measured in Aiken 1.1.24 unit tests on 2026-10-06. Each number includes the small cost of the test itself.

| Function | Case | CPU steps | Memory units |
|---|---|---|---|
| `groth16.verify` | 2 public inputs, both non-zero | 2,161,608,033 | 90,539 |
| `groth16.verify` | 2 public inputs, one of them 0 | 2,030,928,410 | 89,021 |
| `encoding.label` | one deposit | 5,815,539 | 11,279 |
| `encoding.context` | 1 payout | 20,442,216 | 49,829 |
| `encoding.context` | 4 payouts, each with a script credential, a stake credential, and a datum hash | 65,137,024 | 171,572 |
| `encoding.nullifier_key` | one key | 1,598,855 | 1,105 |
| `groth16.verify`, real `insert` proof | 15 public inputs, 9 of them 0 | 2,604,890,058 | 270,047 |
| `groth16.verify`, real `spend` proof | 6 public inputs | 2,700,200,044 | 150,443 |
| `groth16.verify`, real `ragequit` proof | 4 public inputs | 2,430,918,152 | 120,491 |

Whole runs of the pool validator, measured in Aiken tests with real proofs. The limit for one transaction is 10,000,000,000 CPU steps.

| Action | Case | CPU steps | Memory units |
|---|---|---|---|
| Insert | 4 deposits | 4,259,066,560 | 1,303,951 |
| Insert | 4 queued notes | 3,083,043,009 | 959,424 |
| Settle | 4 payouts, queue of 7, trie proof of 5 levels | 3,163,119,524 | 1,525,372 |
| Ragequit | a deposit note | 2,628,484,625 | 731,595 |

A skipped zero input saves 130,679,623 CPU. So one proof check costs about 1.90B CPU plus 0.131B for each non-zero public input.
That is close to the model in SPEC 10.2 (1.87B plus 0.13B).

## 7. Off-chain library

Measured on an Apple M2 Max with Node 24.10.0 on 2026-10-06.

| Operation | Result |
|---|---|
| One Poseidon255 `h2` call | about 0.17 ms |
| Append 200 leaves, then read the root once | 226 hash calls |
| Set one leaf, then read the root | 32 hash calls |

## 8. Development key setup

Measured on an Apple M2 Max with Node 24.10.0 and snarkjs 0.7.6 on 2026-10-06.
The machine ran other builds at the same time, so read the long steps as upper bounds.

| Step | Time |
|---|---|
| Compile the three circuits, forced | about 26 s |
| Compile the three circuits, nothing changed | about 1 s |
| Powers of tau, power 16: contribute | 44 to 51 s |
| Powers of tau, power 16: prepare phase 2 | 923 to 1,145 s |
| Powers of tau, power 16: verify | 17 s |
| Groth16 setup for `spend`, `insert`, `ragequit` | 71 s, 96 s, 46 s |
| Full setup, first run | 1,663 s |
| Setup when every key is cached | under 1 s |

Two forced builds gave the same R1CS files, so the circuit build is reproducible.

| Circuit | R1CS SHA-256 |
|---|---|
| `spend` | `f7cbe870ef2fa3897cc61f62ea3382617c4b5f7539421aee7c7809b96dae31cf` |
| `insert` | `c1fec5a85f5e84ce270cb327d0548f7a9bfeeb144067fa13494f86b41007c7ca` |
| `ragequit` | `ec97e315ebf705e07913f7de0dec0c9fd79423fbfe1e5c73c48de580bffde91c` |

The keys are not reproducible. snarkjs mixes 64 random bytes from the operating system into every contribution, even when the caller passes a fixed text.
So each machine gets its own development keys, and proof fixtures must carry the verification key they were made with.

## Before the build: the first measurements

Measured on 2026-10-06.

These numbers were measured for this project before any product code existed.
They are the evidence behind the main design decisions in [SPEC.md](./SPEC.md).

### 1. Existing code, measured with Aiken 1.1.19

| What | CPU steps | Memory | Test |
|---|---|---|---|
| Groth16 verify, Cardano Foundation code, inputs `[1, 48]` | 2,139,202,479 | 45,891 | `t_single_verify_still_works` |
| Groth16 verify, ak-381, 4 public inputs | 2,399,758,405 | 45,781 | `snark_1` |
| One Poseidon hash on-chain | 1,271,273,371 | 3,696,424 | `poseidon_hashes_one_two` |
| Foundation pool test, two spends at depth 3 | 30,661,577,061 | 89,169,983 | `t_state_transition_two_escapes_depth3` |
| Nullifier insert into a small trie | 9,726,776 | 31,609 | `insert_nullifier` |

Limits for comparison: 10,000,000,000 CPU and 16,500,000 memory per transaction on mainnet.

What these show:

- One proof check uses about a fifth to a quarter of a transaction.
- One Poseidon hash on-chain uses 13% of the CPU limit and 22% of the memory limit.
- The Foundation pool test is 3 times over the CPU limit and 5 times over the memory limit. Its tests pass only because the test runner sets no limit.

#### How to reproduce

1. Download Aiken 1.1.19 or later from the `aiken-lang/aiken` releases page.
2. Clone the Foundation repo: `git clone --depth 1 https://github.com/cardano-foundation/bls` (commit `d0128d8` was used).
3. Run `aiken check bls/aiken/f5/pool-contract`. Each test prints its CPU and memory.
4. Clone Semaphore: `git clone --depth 1 https://github.com/Modulo-P/Cardano-Semaphore` (commit `017aed8` was used).
5. Run `aiken check Cardano-Semaphore`. One upstream test, `spend_signal_semaphore_1`, fails at that commit. The two tests used here pass.

Raw output: [research/data/aiken-check-cf-f5-pool.json](./research/data/aiken-check-cf-f5-pool.json) and [research/data/aiken-check-cardano-semaphore.json](./research/data/aiken-check-cardano-semaphore.json).

### 2. Live protocol parameters

Read from `https://api.koios.rest/api/v1/epoch_params?limit=1` at mainnet epoch 659.
Snapshot: [research/data/koios-mainnet-epoch-params.json](./research/data/koios-mainnet-epoch-params.json).

### 3. Code reading findings

- The Foundation batch verifier derives its random factor from the proofs and the key, not from the public inputs. That looks unsound for a pool, because inputs could be shifted between batched proofs. No exploit was built. This project does not use batch verification.
- The Foundation `privacy_pool` circuit does not range-check its public `fee`, and the pool contract does not bound it. This project fixes the total withdrawn amount in the proof and range-checks it on-chain.
- The stock TypeScript x402 facilitator accepts any transaction with at least one key or script witness that conserves value and pays the recipient. Source files are listed in the x402 digest.

### 4. Spike results, measured with Aiken 1.1.24

The spike code is in [research/spikes/](./research/spikes/). Both spikes were rerun by the lead after the workers finished.

#### 4.1 The proof pipeline works

A snarkjs Groth16 proof on curve `bls12-381` was converted to compressed bytes and verified with Plutus builtins.

| Test | Result | CPU steps | Memory |
|---|---|---|---|
| Valid proof, 2 public inputs | Valid | 2,402,366,517 | 81,457 |
| Valid proof, one input is 0 and is skipped | Valid | 2,271,854,186 | 80,403 |
| Proof with one point replaced | Invalid | 2,404,114,076 | 86,642 |
| Wrong public input | Invalid | 2,402,955,290 | 83,822 |
| Input `x + r`, with the range check | Invalid | 2,648,658 | 11,966 |
| Input `x + r`, without the range check | Valid | 2,399,561,250 | 70,924 |
| Valid proof through the multi-scalar builtin | Valid | 2,819,520,567 | 111,819 |

What these show:

- Skipping a zero input saves 130,512,331 CPU. That confirms the cost of one public input.
- Without the range check, an aliased input verifies. Rule V1 in the Spec is required.
- The multi-scalar builtin was 417M CPU slower than the loop for this circuit.

#### 4.2 Curve points in data structures cost extra

| Test | CPU steps |
|---|---|
| Uncompress a G1 point and use it | 53,550,230 |
| Uncompress a G1 point, wrap it in `Option`, unwrap it, use it | 110,701,463 |
| Uncompress a G2 point and use it | 75,759,594 |
| Uncompress a G2 point, wrap it in `Option`, unwrap it, use it | 155,108,418 |

Aiken stores a curve point inside a data structure as compressed bytes.
One wrap costs about 57M CPU for G1 and 79M CPU for G2.

The spike verifier returns points in `Option` four times. That explains why it measures 2.40B CPU where the unit costs predict about 2.15B.
The product verifier must avoid such wraps (Spec rule V6).

#### 4.3 Unit costs match the live cost model

| Operation | Measured | Live cost model |
|---|---|---|
| One Miller loop | about 254.1M | 254,006,273 |
| One Miller loop plus final verify | about 587.6M | 587,855,987 |

Aiken 1.1.19 and 1.1.24 gave identical numbers for these tests.

#### 4.4 Library compatibility

`aiken-lang/merkle-patricia-forestry` 2.1.0 compiled and passed its insert test with Aiken 1.1.24 and each of these stdlib versions: v2.2.1, v3.1.0, v4.0.0.
An insert into an empty trie cost 5,500,046 CPU and 21,818 memory.

#### 4.5 Poseidon255 constraint counts

Measured with circom 2.2.3.

| Template | Constraints at `--O2` | Non-linear at the default level | Linear at the default level |
|---|---|---|---|
| `Poseidon255(1)` | 213 | 216 | 256 |
| `Poseidon255(2)` | 237 | 240 | 384 |
| `Poseidon255(3)` | 261 | 264 | 512 |

The default level keeps linear constraints. Compile with `--O2`, or each hash costs about 2.6 times more constraints.

#### 4.6 Pitfalls found by the spikes

1. snarkjs writes each G2 coordinate as `[c0, c1]`. The compressed bytes need `c1` first. Bytes in the snarkjs order were rejected.
2. A snarkjs setup is not reproducible, even with fixed entropy text. Keep the generated keys. Do not expect to rebuild them.
3. `@noble/curves` version 2 needs the import path `@noble/curves/bls12-381.js`. Its `multiply(0n)` throws.
4. The JavaScript Poseidon library does not range-check inputs. `H1(r)` equals `H1(0)`.
5. A script that calls snarkjs must call `process.exit` at the end, or it hangs on worker threads.
6. `circom2` needs a real `node_modules` folder in the working directory. A symlink failed.
7. The multi-scalar builtin ignores extra list elements. It also reduces scalars modulo `r`.
8. The trie library is imported as `aiken/merkle_patricia_forestry`. `mpf.empty` is a constant, not a function.
9. `aiken check` prints JSON to standard output when it is not a terminal. Its shape differs from the published schema.
10. In JavaScript, use division for tree indexes above 2^31. The `>>` operator is a signed 32-bit shift.
11. `snarkjs.wtns.check` needs a logger object. Without one it crashes when a witness is wrong.
