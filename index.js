import React, { useState, useCallback, useRef } from 'react';

// --- API Configuration ---
const apiKey = ""; 
// gemini-2.5-flash-preview-09-2025 is used for text and vision tasks
const TEXT_MODEL = "gemini-2.5-flash-preview-09-2025";
// gemini-2.5-flash-image-preview is used for image generation/manipulation
const IMAGE_MODEL = "gemini-2.5-flash-image-preview"; 

// --- THEME DEFINITIONS ---
const THEME_CONTENT_MODIFIERS = {
    'Fantasy': 'Ancient mythical realm, epic scope, quest for powerful artifacts, highly detailed world-building, high fantasy setting.',
    'Comedy': 'Wild and wacky elements, absurd plot devices, bright colors, exaggerated expressions, slapstick, unexpected character placement, ridiculous situation.',
    'Domestic': 'Suburban home, familiar household objects, soft lighting, cozy environment, mundane setting, focus on simple tasks and activities at home, slice-of-life.',
};

const TEXT_SYSTEM_PROMPTS = {
    // The Vision model's description (Turn 1) is now the SOLE visual grounding.
    'Fantasy': `You are a creative co-author for an epic quest. Look back through the history to find the most recent detailed scene description (provided by the Vision Model on the first turn). Use this as your primary grounding for the visual state. Your task is to generate the next three distinct action options for the user. These options MUST: 1) Be a concrete, descriptive action the protagonist is taking; 2) Be highly visually descriptive and distinct; 3) Drive an epic quest or high-stakes confrontation, focusing on magic, combat, or ancient lore. Your response MUST be a JSON object containing one field: "choices", which is an array of strings.`,
    'Comedy': `You are a hilarious, chaotic co-author for a comedy adventure. Look back through the history to find the most recent detailed scene description (provided by the Vision Model on the first turn). Use this as your primary grounding for the visual state. Your task is to generate the next three distinct action options for the user. These options MUST: 1) Be a concrete, descriptive action the protagonist is taking; 2) Be highly visually descriptive and distinct; 3) Prioritize physical comedy, absurd/unlikely actions, or bizarre character interaction to create chaos and plot divergence. Your response MUST be a JSON object containing one field: "choices", which is an array of strings.`,
    'Domestic': `You are a mindful, grounded co-author for a domestic adventure. Look back through the history to find the most recent detailed scene description (provided by the Vision Model on the first turn). Use this as your primary grounding for the visual state. Your task is to generate the next three distinct action options for the user. These options MUST: 1) Be a concrete, descriptive action the protagonist is taking; 2) Be highly visually descriptive and distinct; 3) Focus on low-stakes, relatable, simple physical tasks (e.g., cleaning, minor repairs, food prep) or simple decision points. Your response MUST be a JSON object containing one field: "choices", which is an array of strings.`,
};

const STYLE_MODIFIERS = {
    'Cinematic Painting': 'cinematic, highly detailed, dramatic atmosphere, brushstrokes, oil on canvas, 8k',
    'Manga': 'Japanese manga art, detailed linework, black and white shading, high contrast, dramatic, detailed panel composition', 
    'Watercolor Concept': 'loose watercolor sketch, concept art, high negative space, minimal detail, rough ink wash, expressive brushstrokes, emotional atmosphere, soft edges, art direction sheet'
};

// --- Utility Functions ---

/**
 * Executes a fetch request with exponential backoff for retries.
 */
async function fetchWithRetry(url, payload, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                // Read the response text for better error logging
                const errorText = await response.text();
                throw new Error(`HTTP error! status: ${response.status}. Details: ${errorText}`);
            }
            return response;

        } catch (error) {
            if (i === maxRetries - 1) {
                throw error;
            }
            const delay = Math.pow(2, i) * 1000;
            console.warn(`Attempt ${i + 1} failed. Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error("Maximum retries reached for API call.");
}

/**
 * Converts base64 image data to a Blob and creates a temporary URL.
 */
const base64ToBlobAndUrl = (base64) => {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: 'image/png' });
    return URL.createObjectURL(blob);
};

/**
 * Resizes a base64 image down to a target width (maintaining aspect ratio).
 * This reduces the payload size for the Vision Model during the single 'describeImage' step.
 */
const resizeBase64Image = (base64Data, maxWidth = 800) => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let width = img.width;
            let height = img.height;

            if (width > maxWidth) {
                height = height * (maxWidth / width);
                width = maxWidth;
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            // Convert canvas content back to base64
            const resizedBase64 = canvas.toDataURL('image/png').split(',')[1];
            resolve(resizedBase64);
        };
        img.onerror = (error) => reject(new Error('Failed to load image for resizing.'));
        img.src = `data:image/png;base64,${base64Data}`;
    });
};


/**
 * Generates choices using the light narrative history, returning choices and duration.
 */
const generateOptions = async (narrativeHistory, theme) => {
    const start = performance.now(); 
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${apiKey}`;
    const dynamicSystemPrompt = TEXT_SYSTEM_PROMPTS[theme] || TEXT_SYSTEM_PROMPTS['Fantasy'];

    const payload = {
        contents: narrativeHistory, 
        systemInstruction: { parts: [{ text: dynamicSystemPrompt }] },
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    "choices": {
                        "type": "ARRAY",
                        "items": { "type": "STRING" },
                        "description": "Exactly 3 distinct, compelling, and descriptive choices."
                    }
                },
                "propertyOrdering": ["choices"]
            }
        }
    };

    const response = await fetchWithRetry(url, payload);
    const result = await response.json();

    const jsonText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!jsonText) throw new Error("Text generation returned empty content.");

    let parsed;
    try {
        // Remove markdown triple backticks and 'json' tag if present
        const cleanJsonText = jsonText.replace(/```json\n?|```/g, '').trim();
        parsed = JSON.parse(cleanJsonText);
    } catch (e) {
        console.error("Failed to parse JSON from model:", jsonText, e);
        throw new Error("Model returned malformed JSON structure.");
    }
    
    if (!Array.isArray(parsed.choices)) {
        throw new Error("Model returned invalid choices array structure.");
    }
    
    const duration = performance.now() - start; 
    return { choices: parsed.choices, duration };
};

/**
 * Generates the scene image, using the full multimodal image history, returning image data and duration.
 * This uses the Image-to-Image model.
 */
const generateImage = async (imageHistory, currentPrompt, theme, style, isRefiningStep = false) => {
    const start = performance.now(); 
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${apiKey}`;
    
    const themeContent = THEME_CONTENT_MODIFIERS[theme] || THEME_CONTENT_MODIFIERS['Fantasy'];
    
    let narrativeInstruction;
    if (isRefiningStep) {
         narrativeInstruction = `Modify the scene in the previous image (provided in history) using this visual instruction: ${currentPrompt}`;
    } else {
         narrativeInstruction = `Advance the scene in the previous image (provided in history) based on the user's action: ${currentPrompt}`;
    }
    
    const styleModifier = STYLE_MODIFIERS[style] || STYLE_MODIFIERS['Watercolor Concept']; 
    const qualityInstructions = `${styleModifier} --ar 16:9`;

    const finalImagePrompt = `${themeContent}. ${narrativeInstruction}. ${qualityInstructions}`;
    
    // Append the final constructed prompt (as the user's latest input) to the existing multimodal history
    const contentsForImage = [
        ...imageHistory, 
        { role: "user", parts: [{ text: finalImagePrompt }] } 
    ];

    const payload = {
        contents: contentsForImage, 
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE']
        }
    };

    const response = await fetchWithRetry(url, payload);
    const result = await response.json();

    const part = result?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    const base64Data = part?.inlineData?.data;
    
    if (!base64Data) {
         let errorMessage = "Image generation returned empty data.";
         const candidate = result?.candidates?.[0];
         if (candidate) {
            const safetyRatings = candidate.safetyRatings;
            if (safetyRatings && safetyRatings.length > 0) {
                const blockedCategories = safetyRatings
                    .filter(r => r.probability !== 'NEGLIGIBLE' && r.blocked)
                    .map(r => `${r.category} (P: ${r.probability})`)
                    .join(', ');
                
                if (blockedCategories) {
                    errorMessage += ` Generation was blocked due to safety flags: ${blockedCategories}.`;
                }
            }
         }
        throw new Error(errorMessage);
    }

    const duration = performance.now() - start; 

    return {
        dataUrl: `data:image/png;base64,${base64Data}`,
        data: base64Data, // Raw data for immediate Vision grounding (if needed)
        duration
    };
};

/**
 * Uses the Vision model to describe the generated image (Narrative Grounding Step - runs ONLY ONCE).
 */
const describeImage = async (base64Image) => {
    const start = performance.now(); 
    
    const resizedBase64 = await resizeBase64Image(base64Image, 800);
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${apiKey}`;

    const prompt = `This is the initial scene description. Analyze the image and provide a single, detailed paragraph that describes the protagonist(s) and the major visual elements (objects, landscapes, atmosphere, or potential threats). This description is the sole visual seed for the continuing narrative thread.`;
    
    const payload = {
        contents: [{
            role: "user",
            parts: [
                { text: prompt },
                {
                    inlineData: {
                        mimeType: "image/png",
                        data: resizedBase64
                    }
                }
            ]
        }],
        generationConfig: {
             temperature: 0.5,    
        },
    };

    const response = await fetchWithRetry(url, payload);
    const result = await response.json();
    
    const rawResultJson = JSON.stringify(result, null, 2);

    const candidate = result?.candidates?.[0];
    const description = candidate?.content?.parts?.[0]?.text;
    
    if (!description) {
        let errorMessage = "Image description returned empty content. ";
        
        if (result.error) {
            errorMessage = `API Error: ${result.error.message || 'Unknown API issue.'}`;
        } else if (candidate) {
             errorMessage += `Finish Reason: ${candidate.finishReason || 'N/A'}.`;
            // Add safety check error handling for debug
            const safetyRatings = candidate.safetyRatings;
            if (safetyRatings && safetyRatings.length > 0) {
                const blockedCategories = safetyRatings
                    .filter(r => r.probability !== 'NEGLIGIBLE' && r.blocked)
                    .map(r => `${r.category} (P: ${r.probability})`)
                    .join(', ');
                
                if (blockedCategories) {
                    errorMessage += ` Generation was blocked due to safety flags: ${blockedCategories}.`;
                }
            }
        }
        
        throw new Error(errorMessage);
    }
    
    const duration = performance.now() - start; 
    return { description, duration, rawResultJson };
};


// --- Main React Component ---

const App = () => {
    const inputRef = useRef(null); 
    const refinementInputRef = useRef(null); 
    
    // THREAD 1: Stores full multimodal history (text + Base64) for image-to-image iteration.
    const [imageHistory, setImageHistory] = useState([]); 
    
    // THREAD 2: Stores text history (user actions + (1x) model description + choice JSON).
    const [narrativeHistory, setNarrativeHistory] = useState([]); 
    
    // Tracks if the initial description has been run.
    const [isInitialSceneSet, setIsInitialSceneSet] = useState(false);
    
    const [theme, setTheme] = useState('Fantasy'); 
    const [imageStyle, setImageStyle] = useState('Watercolor Concept'); 

    const [adventureText, setAdventureText] = useState(null); 
    const [options, setOptions] = useState([]);
    const [imageUrl, setImageUrl] = useState(null); 
    const [imageObjectUrl, setImageObjectUrl] = useState(null); 
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    
    // NEW STATE FOR REFINEMENT MODE
    const [isRefining, setIsRefining] = useState(false);
    const [refinementPrompt, setRefinementPrompt] = useState('');
    
    // Debug info
    const [stepTimings, setStepTimings] = useState({ total: 0, image: 0, describe: 0, options: 0 });
    const [visionModelResponse, setVisionModelResponse] = useState(null);

    // Effect to clean up the object URL when the component unmounts or imageObjectUrl changes
    React.useEffect(() => {
        return () => {
            if (imageObjectUrl) {
                URL.revokeObjectURL(imageObjectUrl);
            }
        };
    }, [imageObjectUrl]);
    
    // Utility to revoke previous Object URL
    const revokePreviousUrl = useCallback(() => {
        if (imageObjectUrl) {
            URL.revokeObjectURL(imageObjectUrl);
        }
        setImageObjectUrl(null);
    }, [imageObjectUrl]);

    // Function to handle the image refinement loop (Image-only step)
    const handleRefine = useCallback(async () => {
        const prompt = refinementPrompt.trim();
        if (!prompt) {
            setError("Please enter a visual instruction to refine the image.");
            return;
        }

        const totalStart = performance.now();
        setLoading(true);
        setError(null);
        revokePreviousUrl();

        setAdventureText(`Refining scene: "${prompt}"`);
        
        let imageTime = 0;

        try {
            // 1. GENERATE IMAGE (Image-to-Image with refinement prompt)
            const imageResult = await generateImage(imageHistory, prompt, theme, imageStyle, true);
            imageTime = imageResult.duration;
            
            // 2. Update UI and Histories (Image only)
            setImageUrl(imageResult.dataUrl); 
            const newObjectUrl = base64ToBlobAndUrl(imageResult.data);
            setImageObjectUrl(newObjectUrl);

            const newUserPart = {
                role: "user",
                parts: [{ text: `Refinement: ${prompt}` }]
            };
            const newImageModelPart = {
                role: "model",
                parts: [{ inlineData: { mimeType: "image/png", data: imageResult.data } }]
            };

            setImageHistory(prev => [ ...prev, newUserPart, newImageModelPart ]);
            
            // Do NOT touch narrativeHistory or options.
            setRefinementPrompt('');
            setIsRefining(false);
            
        } catch (err) {
            console.error('Refinement Error:', err);
            setError(`Oops! Refinement failed: ${err.message}.`);
        } finally {
            const totalTime = performance.now() - totalStart;
            setStepTimings({
                total: totalTime,
                image: imageTime,
                describe: 0,
                options: 0
            });
            setLoading(false);
        }
    }, [imageHistory, theme, imageStyle, refinementPrompt, revokePreviousUrl]);

    // Main function to advance the adventure (Narrative + Image step)
    const handleNarrativeStep = useCallback(async (newPrompt) => {
        const totalStart = performance.now(); 
        
        setLoading(true);
        setError(null);
        setStepTimings({ total: 0, image: 0, describe: 0, options: 0 });
        setVisionModelResponse(null);
        revokePreviousUrl();

        setAdventureText(newPrompt);

        // 1. Define the User's action part (text only, used in both threads)
        const newUserPart = {
            role: "user",
            parts: [{ text: newPrompt }]
        };
        
        let imageTime = 0;
        let describeTime = 0;
        let optionsTime = 0;
        
        try {
            let imageResult;
            let textResult;
            let narrativeHistoryForNextStep; 

            if (!isInitialSceneSet) {
                // --- INITIAL TURN (SEQUENTIAL: Image -> Describe -> Choices) ---
                
                // 1a. GENERATE IMAGE
                imageResult = await generateImage(imageHistory, newPrompt, theme, imageStyle);
                imageTime = imageResult.duration;
                
                // 1b. DESCRIBE IMAGE (ONLY ONCE for Narrative Grounding)
                const describeObject = await describeImage(imageResult.data);
                const descriptionToPersist = describeObject.description;
                const rawResponse = describeObject.rawResultJson;
                describeTime = describeObject.duration;
                
                setVisionModelResponse(rawResponse); 
                setIsInitialSceneSet(true); 

                // 1c. Prepare Narrative History with persistent description
                const narrativeDescriptionPart = {
                    role: "model", 
                    parts: [{ text: descriptionToPersist }]
                };
                narrativeHistoryForNextStep = [ ...narrativeHistory, newUserPart, narrativeDescriptionPart ];
                
                // 1d. GENERATE CHOICES
                const optionsObject = await generateOptions(narrativeHistoryForNextStep, theme);
                textResult = optionsObject;
                optionsTime = optionsObject.duration;

            } else {
                // --- SUBSEQUENT TURNS (PARALLEL: Image AND Choices - NO VISION STEP) ---

                narrativeHistoryForNextStep = [ ...narrativeHistory, newUserPart ];

                // Start Image and Choices generation in PARALLEL
                const imagePromise = generateImage(imageHistory, newPrompt, theme, imageStyle);
                const optionsPromise = generateOptions(narrativeHistoryForNextStep, theme);

                const [resolvedImageObject, resolvedOptionsObject] = await Promise.all([imagePromise, optionsPromise]);

                imageResult = resolvedImageObject;
                textResult = resolvedOptionsObject;
                
                imageTime = resolvedImageObject.duration; 
                optionsTime = resolvedOptionsObject.duration;
            }

            // --- COMMON FINAL STEPS ---

            // 3. Update UI
            setImageUrl(imageResult.dataUrl); 
            setOptions(textResult.choices);
            
            const newObjectUrl = base64ToBlobAndUrl(imageResult.data);
            setImageObjectUrl(newObjectUrl);

            // 4. Create Model Response Parts
            const newImageModelPart = {
                role: "model",
                parts: [{ inlineData: { mimeType: "image/png", data: imageResult.data } }]
            };
            const modelChoicesPart = {
                role: "model",
                parts: [{ text: JSON.stringify({ choices: textResult.choices }) }]
            };

            // 5. Update Persistent Histories
            setImageHistory(prev => [ ...prev, newUserPart, newImageModelPart ]);
            setNarrativeHistory(prev => [ ...narrativeHistoryForNextStep, modelChoicesPart ]);
            
        } catch (err) {
            console.error('API Error:', err);
            setError(`Oops! The adventure generator encountered an error: ${err.message}. Please try a different prompt or restart.`);
        } finally {
            const totalTime = performance.now() - totalStart;
            setStepTimings({
                total: totalTime,
                image: imageTime,
                describe: describeTime,
                options: optionsTime
            });
            setLoading(false);
        }
    }, [imageHistory, narrativeHistory, theme, imageStyle, isInitialSceneSet, revokePreviousUrl]); 

    // Function to handle the initial seed input
    const startAdventure = () => {
        const text = inputRef.current ? inputRef.current.value.trim() : ''; 
        
        if (text) {
            handleNarrativeStep(text);
        }
    };

    // Resets the game state
    const resetAdventure = () => {
        setAdventureText(null);
        setOptions([]);
        setImageUrl(null);
        setImageHistory([]); 
        setNarrativeHistory([]);
        setIsInitialSceneSet(false); 
        setError(null);
        setTheme('Fantasy'); 
        setStepTimings({ total: 0, image: 0, describe: 0, options: 0 }); 
        setVisionModelResponse(null); 
        setIsRefining(false);
        setRefinementPrompt('');
        
        revokePreviousUrl();
        
        if (inputRef.current) {
            inputRef.current.value = '';
        }
    };
    
    const formatTime = (ms) => (ms / 1000).toFixed(2);
    
    // Debug Component
    const DebugConsole = () => {
        const [isOpen, setIsOpen] = useState(false);
        
        return (
            <div className="mt-4 border-t border-gray-700 pt-2 flex-shrink-0">
                <button 
                    onClick={() => setIsOpen(!isOpen)}
                    className="flex justify-between items-center w-full text-sm font-semibold text-gray-400 hover:text-yellow-400 transition"
                >
                    Performance & Debug Info ({stepTimings.total > 0 ? formatTime(stepTimings.total) + 's' : 'Ready'})
                    <svg className={`w-4 h-4 transform transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                </button>
                
                {isOpen && (
                    <div className="mt-2 p-3 bg-gray-700 rounded-lg text-xs space-y-3">
                        {/* Timings */}
                        <div className="font-mono text-gray-300">
                            <h4 className="text-yellow-300 font-bold mb-1">Step Timings (s)</h4>
                            <div className="flex flex-wrap space-x-4">
                                <span>Total: <span className="text-white">{formatTime(stepTimings.total)}</span></span>
                                <span>Img: <span className="text-white">{formatTime(stepTimings.image)}</span></span>
                                {stepTimings.describe > 0 && <span>Desc: <span className="text-white">{formatTime(stepTimings.describe)}</span></span>}
                                <span>Opts: <span className="text-white">{formatTime(stepTimings.options)}</span></span>
                            </div>
                        </div>
                        
                        {/* Raw Vision Model Response */}
                        {visionModelResponse && (
                            <div className="font-mono text-gray-300 overflow-x-auto">
                                <h4 className="text-yellow-300 font-bold mb-1 mt-2">Vision Model Response (Turn 1 Only)</h4>
                                <pre className="whitespace-pre-wrap p-2 bg-gray-800 rounded text-gray-400 text-[10px] max-h-48 overflow-y-auto">
                                    {visionModelResponse}
                                </pre>
                            </div>
                        )}
                        
                        {/* Narrative History Display */}
                        <div className="font-mono text-gray-300 overflow-x-auto">
                            <h4 className="text-yellow-300 font-bold mb-1 mt-2">Narrative History (for Options Model)</h4>
                            <pre className="whitespace-pre-wrap p-2 bg-gray-800 rounded text-gray-400 text-[10px] max-h-48 overflow-y-auto">
                                {JSON.stringify(narrativeHistory, null, 2)}
                            </pre>
                        </div>
                        
                    </div>
                )}
            </div>
        );
    }

    // Component to render the game state
    const AdventureView = () => (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="bg-gray-800 p-4 shadow-lg rounded-xl mb-4 flex-shrink-0 border-t-4 border-yellow-500">
                <h2 className="text-xl font-bold text-yellow-300 mb-2">
                    Current Scene 
                    <span className="font-normal text-gray-400 text-base"> (Theme: {theme} / Style: {imageStyle})</span>
                </h2>
                <p className="text-gray-300 mb-3 italic">
                    {adventureText}
                </p>
                <div className="relative w-full aspect-[16/9] bg-gray-700 rounded-lg overflow-hidden border-2 border-gray-600">
                    {loading && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900 bg-opacity-80 z-10">
                            <svg className="animate-spin h-8 w-8 text-yellow-400 mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            <span className="text-white text-sm">
                                {isRefining ? 'Applying Refinement...' : 'Generating scene and choices...'}
                            </span>
                        </div>
                    )}
                    {imageUrl ? (
                        <img 
                            src={imageUrl} 
                            alt="Current adventure scene" 
                            className="w-full h-full object-cover"
                            width="100%" height="auto"
                            onError={(e) => { e.target.onerror = null; e.target.src="https://placehold.co/800x450/374151/D1D5DB?text=Image+Load+Failed"; }}
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400 text-center p-4">
                            Image loading...
                        </div>
                    )}
                </div>
                
                {/* --- Image Link (using createObjectURL) --- */}
                {imageObjectUrl && (
                    <div className="mt-4 flex flex-col space-y-3">
                        <a
                            href={imageObjectUrl}
                            download="dual_ai_scene.png"
                            className="w-full text-center px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-gray-900 font-bold rounded-xl shadow-md transition duration-300 transform hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
                        >
                            Download Current Image
                        </a>
                    </div>
                )}
            </div>
            
            {/* --- REFINEMENT INPUT --- */}
            {isRefining ? (
                <div className="flex flex-col space-y-3 flex-grow-0 pb-4">
                    <h3 className="text-lg font-semibold text-yellow-300">Refine the Scene:</h3>
                    <textarea
                        ref={refinementInputRef}
                        value={refinementPrompt}
                        onChange={(e) => setRefinementPrompt(e.target.value)} 
                        placeholder="e.g., 'Make the dragon's scales metallic blue' or 'Add a small, mischievous cat in the foreground'"
                        rows="2"
                        className="w-full p-3 text-base bg-gray-700 border border-gray-600 rounded-xl text-white focus:ring-yellow-500 focus:border-yellow-500 transition duration-300"
                        disabled={loading}
                    />
                    <div className="flex space-x-3">
                        <button
                            onClick={handleRefine}
                            disabled={loading || refinementPrompt.trim().length === 0}
                            className="flex-1 p-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow-md transition duration-300 disabled:opacity-50 transform hover:scale-[1.01] active:scale-[0.99]"
                        >
                            {loading ? 'Applying...' : 'Apply Refinement'}
                        </button>
                        <button
                            onClick={() => { setIsRefining(false); setRefinementPrompt(''); }}
                            disabled={loading}
                            className="p-3 bg-gray-500 hover:bg-gray-600 text-white font-bold rounded-xl shadow-md transition duration-300 disabled:opacity-50"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            ) : (
                // --- NARRATIVE CHOICES ---
                <div className="flex flex-col space-y-3 flex-grow overflow-y-auto pb-4">
                    <div className="flex justify-between items-center">
                        <h3 className="text-lg font-semibold text-yellow-300">Choose your next step:</h3>
                        <button
                            onClick={() => setIsRefining(true)}
                            disabled={loading}
                            className="p-2 text-sm bg-gray-600 hover:bg-gray-700 text-white font-medium rounded-lg transition duration-300 disabled:opacity-50"
                        >
                            Refine Image First
                        </button>
                    </div>
                    {options.length > 0 ? options.map((option, index) => (
                        <button
                            key={index}
                            onClick={() => handleNarrativeStep(option)}
                            disabled={loading}
                            className="w-full p-4 text-left bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl shadow-md transition duration-300 disabled:opacity-50 disabled:cursor-not-allowed transform hover:scale-[1.01] active:scale-[0.99] focus:outline-none focus:ring-2 focus:ring-blue-400 text-base sm:text-lg"
                        >
                            {option}
                        </button>
                    )) : (
                        <div className="p-4 text-center text-gray-400 bg-gray-700 rounded-xl">
                            Awaiting the next set of choices...
                        </div>
                    )}
                </div>
            )}
            
            {/* --- Debug Console --- */}
            <DebugConsole />
            
            <button
                onClick={resetAdventure}
                className="mt-3 p-3 bg-red-800 hover:bg-red-700 text-white font-medium rounded-xl shadow-lg transition duration-300 flex-shrink-0 transform hover:scale-[1.01] active:scale-[0.98]"
            >
                Start New Adventure
            </button>
        </div>
    );

    // Start Screen Component remains unchanged
    const StartScreen = ({ inputRef, loading, startAdventure, theme, setTheme, imageStyle, setImageStyle }) => {
        const [isTextEntered, setIsTextEntered] = useState(false);

        const handleTextChange = (e) => {
            setIsTextEntered(e.target.value.trim().length > 0);
        };
        
        const handleKeyDown = (e) => {
            const text = inputRef.current ? inputRef.current.value.trim() : '';
            if (e.key === 'Enter' && !e.shiftKey && text && !loading) {
                e.preventDefault();
                startAdventure();
            }
        };

        const isButtonDisabled = () => {
            return !isTextEntered || loading;
        };

        return (
            <div className="flex flex-col items-center justify-center p-6 bg-gray-800 rounded-xl shadow-2xl h-full w-full mx-auto border-4 border-yellow-500">
                <h1 className="text-4xl font-extrabold text-yellow-400 mb-4 text-center">
                    Dual-AI Adventure Generator
                </h1>
                <p className="text-gray-400 text-center mb-6">
                    Enter a starting premise, choose a theme and a visual style, and begin your visual journey.
                </p>
                
                {/* --- Theme Selector --- */}
                <div className="w-full mb-6">
                    <h3 className="text-md font-semibold text-yellow-300 mb-2">Adventure Theme:</h3>
                    <div className="flex justify-between space-x-2">
                        {Object.keys(THEME_CONTENT_MODIFIERS).map((t) => (
                            <button
                                key={t}
                                onClick={() => setTheme(t)}
                                className={`flex-1 p-2 text-sm font-medium rounded-lg transition duration-200 
                                    ${theme === t
                                        ? 'bg-yellow-500 text-gray-900 shadow-xl border-2 border-yellow-300' 
                                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'
                                    }`}
                                disabled={loading}
                            >
                                {t}
                            </button>
                        ))}
                    </div>
                </div>
                {/* ---------------------- */}

                {/* Style Selector */}
                <div className="w-full mb-6">
                    <h3 className="text-md font-semibold text-yellow-300 mb-2">Visual Style:</h3>
                    <div className="flex justify-between space-x-2">
                        {Object.keys(STYLE_MODIFIERS).map((style) => (
                            <button
                                key={style}
                                onClick={() => setImageStyle(style)}
                                className={`flex-1 p-2 text-sm font-medium rounded-lg transition duration-200 
                                    ${imageStyle === style 
                                        ? 'bg-yellow-500 text-gray-900 shadow-xl border-2 border-yellow-300' 
                                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'
                                    }`}
                                disabled={loading}
                            >
                                {style}
                            </button>
                        ))}
                    </div>
                </div>

                <textarea
                    defaultValue="" 
                    ref={inputRef}
                    onChange={handleTextChange} 
                    onKeyDown={handleKeyDown} 
                    placeholder={`Enter your starting premise for a ${theme} adventure...`}
                    rows="3"
                    className="w-full p-4 mb-6 text-lg bg-gray-900 border border-gray-600 rounded-xl text-white focus:ring-yellow-500 focus:border-yellow-500 transition duration-300"
                    disabled={loading}
                />
                <button
                    onClick={startAdventure}
                    disabled={isButtonDisabled()}
                    className="w-full p-4 bg-green-600 hover:bg-green-700 text-white font-bold text-xl rounded-xl shadow-lg transition duration-300 disabled:opacity-50 disabled:cursor-not-allowed transform hover:scale-[1.02] active:scale-[0.98]"
                >
                    {loading ? 'Starting...' : 'Start Adventure!'}
                </button>
            </div>
        );
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white font-sans p-4 sm:p-8 flex justify-center items-stretch">
            <div className="w-full max-w-xl flex flex-col h-[90vh] sm:h-[80vh]">
                {/* Error Banner */}
                {error && (
                    <div className="bg-red-900 border border-red-500 text-red-100 p-3 rounded-xl mb-4 shadow-lg flex-shrink-0">
                        **Error:** {error}
                    </div>
                )}
                {/* Main Content */}
                {adventureText === null 
                    ? <StartScreen 
                        inputRef={inputRef} 
                        loading={loading} 
                        startAdventure={startAdventure}
                        theme={theme}
                        setTheme={setTheme}
                        imageStyle={imageStyle}
                        setImageStyle={setImageStyle}
                    /> 
                    : <AdventureView />
                }
            </div>
        </div>
    );
};

export default App;
