// app/game/[id]/play/page.js
"use client";
import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { init } from "@instantdb/react";
import { id as instantID } from "@instantdb/admin";
import PrepStage from "../stages/PrepStage";
import GameStage from "../stages/GameStage";
import WaitingStage from "../stages/WaitingStage";
import VotingStage from "../stages/VotingStage";
import ResultsStage from "../stages/ResultsStage";

const APP_ID = process.env.NEXT_PUBLIC_INSTANT_APP_ID;
const db = init({ appId: APP_ID });

export default function PlayPage() {
  const router = useRouter();
  const params = useParams();
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [localTimeLeft, setLocalTimeLeft] = useState(null);

  // Subscribe to game state
  const { data } = db.useQuery({
    games: {
      $: {
        where: { gameCode: params.id },
      },
    },
  });

  const game = data?.games?.[0];

  // Function to calculate current time left based on server data
  const calculateTimeLeft = () => {
    if (!game || !game.isTimerRunning) return game?.timeLeft || 0;

    const now = Date.now();
    const elapsed = Math.floor((now - game.timerStart) / 1000);
    return Math.max(0, game.timeLeft - elapsed);
  };

  // Update local timer every second and check for stage completion
  useEffect(() => {
    if (!game) return;

    const interval = setInterval(() => {
      const timeLeft = calculateTimeLeft();
      setLocalTimeLeft(timeLeft);

      // If timer has reached 0, handle stage completion
      if (timeLeft === 0 && game.isTimerRunning) {
        handleStageComplete();
        clearInterval(interval);
      }
    }, 1000);

    // Initial calculation
    setLocalTimeLeft(calculateTimeLeft());

    return () => clearInterval(interval);
  }, [game?.timerStart, game?.timeLeft, game?.isTimerRunning]);

  // Reset submission state when entering game stage
  useEffect(() => {
    if (game?.currentStage === "GAME") {
      setHasSubmitted(false);
    }
  }, [game?.currentStage]);

  useEffect(() => {
    if (data?.games?.length > 0) {
      const game = data.games[0];

      // Handle redirect for all players
      if (game.shouldRedirect && game.redirectTo) {
        router.push(game.redirectTo);
        // Clear the redirect flag
        db.transact(
          db.tx.games[game.id].update({
            shouldRedirect: false,
            redirectTo: null,
          })
        );
      }
    }
  }, [data, router]);

  // In play/page.js, modify the handleStageComplete function
  const handleStageComplete = async () => {
    if (!game) return;

    const nextStage = getNextStage(game.currentStage);
    const nextDuration = getStageDuration(nextStage);

    // Check if we're transitioning from RESULTS to PREP (new round)
    if (game.currentStage === "RESULTS" && nextStage === "PREP") {
      // Create a new round
      const newRoundId = instantID(); // You'll need to import this from @instantdb/admin
      const nextRoundNumber = (game.currentRound || 1) + 1;

      await db.transact([
        // Create the new round
        db.tx.round[newRoundId].update({
          id: newRoundId,
          gameId: game.id,
          roundNumber: nextRoundNumber,
          answers: [],
          submittedPlayers: [],
          votes: [],
          theme: game.theme || "Things a pirate would say",
          prompt: game.prompt || "BBL", // You might want to update the prompt for each round
        }),

        // Link the new round to the game
        db.tx.games[game.id].link({
          roundData: newRoundId,
        }),

        // Update game state for the new round
        db.tx.games[game.id].update({
          currentStage: nextStage,
          timerStart: Date.now(),
          timeLeft: nextDuration,
          isTimerRunning: true,
          currentRound: nextRoundNumber,
          answers: [], // Reset answers for the new round
          submittedPlayers: [], // Reset submitted players
        }),
      ]);

      // Redirect all players to the game with new roundId
      // This is important to update the URL with the new round ID
      await db.transact(
        db.tx.games[game.id].update({
          shouldRedirect: true,
          redirectTo: `/game/${params.id}/play/${newRoundId}`,
        })
      );

    } else {
      // For other stage transitions, just update the game state
      await db.transact(
        db.tx.games[game.id].update({
          currentStage: nextStage,
          timerStart: Date.now(),
          timeLeft: nextDuration,
          isTimerRunning: true,
        })
      );
    }
  };

  const getNextStage = (currentStage) => {
    const stages = {
      "PREP": "GAME",
      "GAME": "VOTING", // Everyone goes to voting when time expires
      "VOTING": "RESULTS",
      "RESULTS": "PREP"
    };
    return stages[currentStage] || "PREP";
  };

  const getStageDuration = (stageName) => {
    const durations = {
      "PREP": 5,     // 5 seconds to prepare
      "GAME": 30,    // 30 seconds to enter answer
      "VOTING": 15,  // 15 seconds to vote
      "RESULTS": 10  // 10 seconds to show results
    };
    return durations[stageName] || 30;
  };

  const handleSubmitAnswer = async (answer) => {
    if (!game) return;

    if (answer !== "") {
      // Store in localStorage
      localStorage.setItem(`answer_${params.id}_${game.currentRound || 1}`, answer);

      // Store answer in the database
      const updatedAnswers = [...(game.answers || []), answer];
      await db.transact(db.tx.games[game.id].update({
        answers: updatedAnswers,
        submittedPlayers: [...(game.submittedPlayers || []), "currentPlayerId"]
      }));
      setHasSubmitted(true);
    }
  };

  const renderStage = () => {
    if (!game) return <div>Loading...</div>;

    // Get the saved answer from localStorage for the current round
    const savedAnswer = typeof window !== 'undefined' ?
      localStorage.getItem(`answer_${params.id}_${game.currentRound || 1}`) : '';

    const commonProps = {
      currentRound: game.currentRound || 1,
      timeLeft: localTimeLeft ?? game.timeLeft,
      theme: game.theme || "Things a pirate would say",
      prompt: game.prompt || "BBL",
      users: game.players || [],
      submittedAnswer: savedAnswer, // Pass the saved answer to all stages
    };

    // Show waiting stage only for players who submitted during game stage
    if (game.currentStage === "GAME" && hasSubmitted) {
      return <WaitingStage {...commonProps} />;
    }

    // Handle other stages
    switch (game.currentStage) {
      case "PREP":
        return <PrepStage {...commonProps} />;
      case "GAME":
        return <GameStage
          {...commonProps}
          handleSubmit={handleSubmitAnswer}
        />;
      case "VOTING":
        return (
          <VotingStage
            {...commonProps}
            answers={game.answers || []}
            showNoSubmissionAlert={!hasSubmitted}
            handleVote={(vote) => {
              console.log(vote);
              handleStageComplete();
            }}
          />
        );
      case "RESULTS":
        return (
          <ResultsStage
            {...commonProps}
            answers={game.answers || []}
            onNext={handleStageComplete}
          />
        );
      default:
        return <div>Loading...</div>;
    }
  };

  return <div className="min-h-screen">{renderStage()}</div>;
}
