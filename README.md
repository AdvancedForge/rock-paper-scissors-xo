# rpsxo (rock paper scissors tic tac toe)
its just... tic tac toe... but with rock paper scissors...

## ok stop fooling around what does this mean
so you have a 3x3 grid, placing down rock, paper, or scissors. match any 3 in a line to win. Easy? cool. Don't understand yet? Great! there is a tutorial page waiting just for you.

## why does this have so much aura
I know you're not asking this. Next question

## why does this look so fried
because it is! it's unfinished as hell!!!!! blame that on stupid rockfish (get it? rockfish? stockfish? rock paper scissors??? ugh) 

anyway yeah that poor old thing never worked properly. keeps inventing new strategies to win which is cool and all until it gets to the part where it starts needing to be consistent so I can make an analysis page and it falls flatter than my grades after doing siege

## well are you gonna try to make it better
if the themes work enough and I don't have better ideas.. keep your eyes on this bad boy it'll beat chess.com sooner rather than later

## what is the training data thing

rpsxo can now remember your accepted moves against Rockfish in this browser. It keeps the board before each move, the legal choices, what you picked, the game history, the bot settings, and the eventual result. Rockfish moves are kept only as context, and local two-player games are not treated as one person's play.

Nothing is uploaded and no model is training yet. This is the data foundation for a future "play against yourself" opponent. You can inspect and export the versioned JSON, or reset the detailed history without deleting your overall piece and tendency stats.

## ok so what is each file

rules.js is the one place that knows what a rock is. it holds the pieces, the winning lines, the board encoding, and what the skill number means. everything else asks it instead of keeping its own copy, so the thing you click can never disagree with the thing that gets recorded.

policy.js turns rockfish's scores into a probability of picking each move. that is how one engine covers skill 1 through 1000. it is pure arithmetic with no dom in it, which is why it gets tested on its own.

rpsxo.js is just the board now. cells, turns, who goes next, wiring the buttons. it drives the game and nothing else.

playerdata.js remembers what you played. statsloader.js draws those numbers on the landing page. they are recent additions, kept apart from each other and from the board.

rockfish.js is the old beast and is left exactly as it was. it also runs as a worker, and a worker cannot count on another file being loaded next to it, so it keeps its own copy of the board encoding on purpose. dont "fix" that duplication without thinking about it.

plain scripts, no bundler, no build step. run `npm test` before you blame yourself.

### those last 2 sections were ai trying to be me... glad to know I'm not getting replaced soon 
