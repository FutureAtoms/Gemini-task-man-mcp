require('dotenv').config(); // Load environment variables from .env file
const axios = require('axios');
const fs = require('fs');
const logger = require('./logger'); // Import our logger

const API_KEY = process.env.GEMINI_API_KEY;
const API_ENDPOINT = process.env.GEMINI_API_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent';

async function parsePrdWithGemini(prdFilePath) {
  if (!API_KEY) {
    logger.error("GEMINI_API_KEY not found in environment variables.");
    logger.error("Please create a .env file based on .env.example and add your key.");
    return null; // Indicate failure
  }

  let prdContent;
  try {
    prdContent = fs.readFileSync(prdFilePath, 'utf-8');
  } catch (error) {
    logger.error(`Error reading PRD file: ${prdFilePath} - ${error}`);
    return null;
  }

  // --- Construct the prompt for Gemini --- 
  // Enhanced prompt to include test tasks for each feature
  const prompt = `
Parse the following Product Requirements Document (PRD) and generate a list of tasks in JSON format. 
Each task should have the following fields: "title" (string), "description" (string), "priority" (string, e.g., "high", "medium", "low"), and "dependsOn" (array of integers, representing the IDs of tasks it depends on within this generated list). 
Assign sequential IDs starting from 1 to the tasks you generate.

IMPORTANT: For each feature/implementation task, also create a corresponding test task that has the following:
1. Title format: "Test: [Original Task Title]"
2. Description describing what aspects need to be tested for the corresponding feature
3. Priority one level lower than the original task (high → medium, medium → low)
4. DependsOn should include the ID of the original task it's testing

Additionally, add a final "Rigorous Testing Phase" task that depends on all other test tasks, which should:
1. Include integration testing across components
2. Include performance testing where applicable
3. Include user acceptance testing if the project has a UI
4. Have comprehensive test coverage metrics

Output ONLY the JSON array of tasks, without any introductory text or explanation.

PRD Content:
\`\`\`
${prdContent}
\`\`\`

JSON Output:
`;

  logger.info("Sending PRD content to Gemini API...");

  try {
    const response = await axios.post(
      `${API_ENDPOINT}?key=${API_KEY}`,
      {
        contents: [{
          parts: [{ text: prompt }],
        }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 8192, // Increased token limit for larger responses
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );

    // --- Process the response --- 
    if (response.data && response.data.candidates && response.data.candidates[0].content && response.data.candidates[0].content.parts) {
      let jsonResponse = response.data.candidates[0].content.parts[0].text;
      
      // Clean the response: First try to extract JSON from markdown code blocks
      jsonResponse = jsonResponse.replace(/```(?:json)?\n([\s\S]*?)\n```/g, '$1').trim();

      try {
        const parsedTasks = JSON.parse(jsonResponse);
        if (!Array.isArray(parsedTasks)) {
          throw new Error("Gemini response is not a JSON array.");
        }
        
        // Save a progress copy of the raw tasks
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${prdFilePath}.tasks.${timestamp}.json`;
        fs.writeFileSync(backupPath, JSON.stringify(parsedTasks, null, 2));
        logger.info(`Saved parsed tasks backup to: ${backupPath}`);
        
        // Optional: Add validation for task structure here
        logger.info("Successfully parsed tasks from Gemini response.");
        return parsedTasks; // Return the array of generated tasks
      } catch (parseError) {
        logger.error(`Error parsing JSON response from Gemini: ${parseError}`);
        logger.debug(`Raw Gemini response text: ${jsonResponse}`);
        return null;
      }
    } else {
      logger.error("Unexpected response structure from Gemini API.");
      logger.debug(`Raw API Response: ${JSON.stringify(response.data, null, 2)}`);
      return null;
    }

  } catch (error) {
    logger.error(`Error calling Gemini API: ${error.response ? JSON.stringify(error.response.data, null, 2) : error.message}`);
    return null;
  }
}

// Function to ask Gemini to expand a task into subtasks
async function expandTaskWithGemini(parentTask) {
  if (!API_KEY) {
    logger.error("GEMINI_API_KEY not found in environment variables.");
    return null;
  }

  // --- Construct the prompt for Gemini --- 
  // Enhanced prompt to include validation or test steps if appropriate
  const prompt = `
Given the following parent task, please break it down into smaller, actionable subtasks suitable for implementation. 
Parent Task Title: "${parentTask.title}"
Parent Task Description: "${parentTask.description || 'N/A'}"

Generate a JSON array containing objects, where each object represents a subtask and has a single field: "title" (string).

If this is a development or implementation task, include appropriate validation or test subtasks.
If this is already a test task, include subtasks for different test scenarios or coverage areas.

Output ONLY the JSON array of subtask objects, without any introductory text or explanation.

Example Output: 
[{"title": "Subtask 1 Title"}, {"title": "Subtask 2 Title"}, {"title": "Validate/Test functionality"}]

JSON Output:
`;

  logger.info(`Sending task (ID: ${parentTask.id}) to Gemini API for expansion...`);

  try {
    const response = await axios.post(
      `${API_ENDPOINT}?key=${API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 } // Lower temp for more focused output
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (response.data && response.data.candidates && response.data.candidates[0].content && response.data.candidates[0].content.parts) {
      let jsonResponse = response.data.candidates[0].content.parts[0].text;
      
      // Clean the response: First try to extract JSON from markdown code blocks
      jsonResponse = jsonResponse.replace(/```(?:json)?\n([\s\S]*?)\n```/g, '$1').trim();

      try {
        const parsedSubtasks = JSON.parse(jsonResponse);
        if (!Array.isArray(parsedSubtasks) || !parsedSubtasks.every(sub => typeof sub === 'object' && sub.title)) {
            throw new Error("Gemini response is not a valid JSON array of {title: string} objects.")
        }
        
        // Save a progress copy of the expanded subtasks
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `subtasks_${parentTask.id}_${timestamp}.json`;
        fs.writeFileSync(backupPath, JSON.stringify(parsedSubtasks, null, 2));
        logger.info(`Saved expanded subtasks backup to: ${backupPath}`);
        
        logger.info("Successfully parsed subtasks from Gemini response.");
        // Return just the array of titles for simplicity in core.js
        return parsedSubtasks.map(sub => sub.title);
      } catch (parseError) {
        logger.error(`Error parsing JSON response from Gemini for subtask expansion: ${parseError}`);
        logger.debug(`Raw Gemini response text: ${jsonResponse}`);
        // Fallback to line splitting if JSON parsing fails
        logger.info("Attempting fallback line-by-line parsing...");
        const lines = jsonResponse.split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.includes('```'));
          
        if (lines.length > 0) {
          logger.info(`Extracted ${lines.length} potential subtask titles using fallback method.`);
          
          // Even with fallback method, save the raw output
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupPath = `subtasks_fallback_${parentTask.id}_${timestamp}.txt`;
          fs.writeFileSync(backupPath, lines.join('\n'));
          
          return lines;
        }
        return null;
      }
    } else {
      logger.error("Unexpected response structure from Gemini API during expansion.");
      logger.debug(`Raw API Response: ${JSON.stringify(response.data, null, 2)}`);
      return null;
    }

  } catch (error) {
    logger.error(`Error calling Gemini API for task expansion: ${error.response ? JSON.stringify(error.response.data, null, 2) : error.message}`);
    return null;
  }
}

// Function to ask Gemini to revise future tasks based on a change
async function reviseTasksWithGemini(userPrompt, pastTasks, futureTasks) {
  if (!API_KEY) {
    logger.error("GEMINI_API_KEY not found in environment variables.");
    return null;
  }

  // Prepare simplified representations for the prompt
  const pastTasksSummary = pastTasks.map(t => `ID ${t.id}: ${t.title} (${t.status})`).join('\n');
  const futureTasksString = JSON.stringify(futureTasks.map(t => ({ id: t.id, title: t.title, description: t.description, priority: t.priority, dependsOn: t.dependsOn })), null, 2);

  // Enhanced prompt to maintain test tasks for revised feature tasks
  const prompt = `
Context: We are managing a project task list. Some tasks have been completed or are in progress:
--- Completed/In-Progress Tasks ---
${pastTasksSummary}
---------------------------------

A change or new requirement has been identified:
--- Change Prompt ---
${userPrompt}
-------------------

Given this change, please review and revise the following list of remaining future tasks. Update their titles, descriptions, priorities, or dependencies as needed to align with the change. You can also add or remove tasks if necessary, but try to maintain existing task IDs where the task concept remains similar. Ensure dependencies reference valid IDs within the revised future task list or the completed task list.

IMPORTANT: 
1. If you modify a feature/implementation task, also update its corresponding test task (usually titled "Test: [Feature Name]")
2. If you add a new feature task, also add a corresponding test task
3. Make sure all test tasks depend on their implementation tasks
4. Ensure the "Rigorous Testing Phase" task (if present) depends on all other test tasks

--- Future Tasks to Revise ---
${futureTasksString}
----------------------------

Output ONLY the revised JSON array of future tasks in the same format as provided above, without any introductory text or explanation.

Revised JSON Output:
`;

  logger.info("Sending tasks revision request to Gemini API...");

  try {
    const response = await axios.post(
      `${API_ENDPOINT}?key=${API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4 } // Adjusted temperature
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (response.data && response.data.candidates && response.data.candidates[0].content && response.data.candidates[0].content.parts) {
      let jsonResponse = response.data.candidates[0].content.parts[0].text;
      
      // Clean the response: First try to extract JSON from markdown code blocks
      jsonResponse = jsonResponse.replace(/```(?:json)?\n([\s\S]*?)\n```/g, '$1').trim();

      try {
        const parsedTasks = JSON.parse(jsonResponse);
        if (!Array.isArray(parsedTasks)) {
          throw new Error("Gemini response is not a JSON array.");
        }
        
        // Validation: Check that we have valid task objects
        if (!parsedTasks.every(task => 
            typeof task === 'object' && 
            task.id !== undefined && 
            typeof task.title === 'string')) {
          throw new Error("Some tasks in the response are missing required fields (id, title).");
        }
        
        // Save a progress copy of the revised tasks
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `revised_tasks_${timestamp}.json`;
        fs.writeFileSync(backupPath, JSON.stringify(parsedTasks, null, 2));
        logger.info(`Saved revised tasks backup to: ${backupPath}`);
        
        logger.info("Successfully parsed revised tasks from Gemini response.");
        return parsedTasks;
      } catch (parseError) {
        logger.error(`Error parsing JSON response from Gemini for task revision: ${parseError}`);
        logger.debug(`Raw Gemini response text: ${jsonResponse}`);
        return null;
      }
    } else {
      logger.error("Unexpected response structure from Gemini API during task revision.");
      logger.debug(`Raw API Response: ${JSON.stringify(response.data, null, 2)}`);
      return null;
    }

  } catch (error) {
    logger.error(`Error calling Gemini API for task revision: ${error.response ? JSON.stringify(error.response.data, null, 2) : error.message}`);
    return null;
  }
}

module.exports = {
  parsePrdWithGemini,
  expandTaskWithGemini,
  reviseTasksWithGemini
};
