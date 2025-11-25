import React, { useState, useEffect, useCallback, useMemo } from 'react';

// --- Importaciones de Firebase ---
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot } from 'firebase/firestore';
import { Check, Plus, Trash2, Trophy, Zap, Loader2, Scale, Activity, Coffee, ChevronRight, User, TrendingUp, Flame, XCircle, BarChart3, Weight, Percent, Cake, Heart, Lightbulb, Settings, Hash, Calculator, Utensils, Footprints, Clock, ArrowDown, ArrowUp, Send, Dumbbell } from 'lucide-react'; 

// Las variables globales son proporcionadas por el entorno de Canvas
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
// CORRECCIÓN: Usar __initial_auth_token si está definido.
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null; 

// --- Configuración Global ---
const XP_PER_LEVEL = 1000;
const INITIAL_GOAL = { 
    id: 'g1', 
    name: 'Transformación Corporal (Salud Óptima)', 
    targetXp: 10000, 
    description: 'Meta principal. El XP se ajusta a tu dificultad.' 
};
const DEFAULT_SETTINGS = {
    difficulty: null,
    initialWeight: null,
    heightCm: null,
    activityLevel: null,
    waterGoal: null,
    sleepGoal: null,
    dob: null, 
    sex: null, 
    age: null, 
    tmb: null, // Tasa Metabólica Basal
    get: null, // Gasto Energético Total (TDEE) - Mantenimiento
    caloricGoal: null, // Calorías Objetivo (GET - Déficit)
};

// --- Fórmulas y Lógica de Nutrición ---

// Factores de Actividad TDEE
const ACTIVITY_FACTORS = {
    sedentary: 1.2, // Sin ejercicio o poco
    light: 1.375, // Ejercicio ligero 1-3 días/semana
    moderate: 1.55, // Ejercicio moderado 3-5 días/semana
    heavy: 1.725, // Ejercicio intenso 6-7 días/semana
    very_heavy: 1.9, // Ejercicio muy intenso + trabajo físico
};

/**
 * Calcula la Tasa Metabólica Basal (TMB) usando la fórmula de Harris-Benedict (revisada).
 */
const calculateTMB = (weightKg, heightCm, ageYears, sex) => {
    if (!weightKg || !heightCm || !ageYears || !sex) return null;

    let tmb;
    if (sex === 'male') {
        // Hombres: 88.362 + (13.397 * P) + (4.799 * A) - (5.677 * E)
        tmb = 88.362 + (13.397 * weightKg) + (4.799 * heightCm) - (5.677 * ageYears);
    } else {
        // Mujeres: 447.593 + (9.247 * P) + (3.098 * H) - (4.330 * E)
        tmb = 447.593 + (9.247 * weightKg) + (3.098 * heightCm) - (4.330 * ageYears);
    }
    return Math.round(tmb);
};

/**
 * Calcula el Gasto Energético Total (GET / TDEE) y la Meta Calórica.
 */
const calculateCaloricGoals = (tmb, activityLevel) => {
    if (!tmb || !activityLevel) return { get: null, caloricGoal: null };

    const activityFactor = ACTIVITY_FACTORS[activityLevel] || 1.2;
    
    const get = Math.round(tmb * activityFactor);
    
    // Déficit estándar para pérdida de peso: 500 kcal
    // Asegurar que la meta no sea peligrosamente baja (ej. mínimo 1200)
    const minGoal = 1200; 
    const caloricGoal = Math.max(minGoal, get - 500);

    return { get, caloricGoal };
};

/**
 * Estima las calorías quemadas por pasos adicionales.
 * Ajuste de la fórmula para que 10,000 pasos quemen entre 300-400 kcal 
 * para un peso promedio (0.0005 Kcal * peso(kg) por paso).
 */
const calculateStepCalories = (steps, weightKg) => {
    if (!steps || !weightKg || steps <= 0) return 0;
    
    // Fórmula: 0.0005 Kcal * peso(kg) por paso
    const caloriesBurned = 0.0005 * weightKg * steps; 
    
    return Math.round(caloriesBurned);
};

/**
 * Estima las calorías quemadas por entrenamiento de fuerza (más preciso que la simple marca de misión).
 */
const calculateStrengthCalories = (minutes, weightKg, sex) => {
    if (!minutes || !weightKg || minutes <= 0) return 0;
    
    // Factor METs simplificado para fuerza: 0.012 Kcal/min/kg
    const baseBurn = 0.012 * minutes * weightKg;

    // Ajuste de intensidad: Hombres (más masa muscular) ligeramente más alto
    const factor = sex === 'male' ? 1.1 : 1.0; 
    
    return Math.round(baseBurn * factor);
};


// --- Lógica de Generación de Misiones ---

/**
 * Genera misiones y XP basado en el nivel de dificultad, edad y sexo.
 */
function calculateInitialMissions(difficulty, settings) {
    const isFemale = settings.sex === 'female';
    // Protein goal based on body weight for muscle maintenance during cut
    const proteinGrams = Math.round((settings.initialWeight || 70) * (isFemale ? 1.8 : 2.2));
    const walkGoalMedium = isFemale ? 7000 : 8000;
    const caloricGoalDisplay = settings.caloricGoal || 'N/A'; // Usar la meta calórica calculada

    let tasks = [
        // CRÍTICO: Nutrición con Meta Calórica fija
        { id: 't1', name: `Registro de Nutrición 100% (Meta: ${caloricGoalDisplay} Kcal + ${proteinGrams}g Proteína)`, xpValue: 250, isCompleted: false },
        { id: 't2', name: 'Cero Azúcares Añadidos (Excepto fruta entera/lácteos)', xpValue: 100, isCompleted: false },
        // CRÍTICO: Seguimiento y Honestidad
        { id: 't7', name: 'Registrar Peso Corporal Diario', xpValue: 75, isCompleted: false }, 
    ];
    let goalXpMultiplier = 1;
    let stepsMission = null;

    switch (difficulty) {
        case 'easy':
            tasks[0].xpValue = 300; 
            stepsMission = { id: 't8', name: 'Caminar 3,000 Pasos (Hábito Mínimo)', xpValue: 50, isCompleted: false, type: 'steps', target: 3000 }; 
            tasks.push(stepsMission);
            goalXpMultiplier = 1.2;
            break;
        case 'medium':
            stepsMission = { id: 't3', name: `Caminar ${walkGoalMedium} Pasos`, xpValue: 100, isCompleted: false, type: 'steps', target: walkGoalMedium };
            tasks.push(stepsMission);
            tasks.push({ id: 't4', name: 'Sesión de Entrenamiento de Fuerza (Mínimo 45 minutos)', xpValue: 150, isCompleted: false, type: 'strength', targetMins: 45 });
            goalXpMultiplier = 1.0;
            break;
        case 'brutal':
            tasks[0].name = `Registro Nutrición (Meta: ${caloricGoalDisplay} Kcal, Meta Proteína: ${proteinGrams}g, Cero procesados)`;
            stepsMission = { id: 't3', name: 'Caminar 10,000 Pasos (No negociable)', xpValue: 150, isCompleted: false, type: 'steps', target: 10000 };
            tasks.push(
                stepsMission,
                { id: 't4', name: 'Sesión de Entrenamiento de Fuerza (Mínimo 60 minutos, 4 veces/semana)', xpValue: 200, isCompleted: false, type: 'strength', targetMins: 60 },
                { id: 't5', name: `Hidratación: Beber ${settings.waterGoal || '3L'} de Agua`, xpValue: 50, isCompleted: false },
                { id: 't6', name: `Descanso: Lograr ${settings.sleepGoal || '7.5h'} de Sueño de Calidad`, xpValue: 50, isCompleted: false }
            );
            tasks[0].xpValue = 350;
            goalXpMultiplier = 0.8;
            break;
        default:
            break;
    }

    const goal = {
        ...INITIAL_GOAL,
        targetXp: Math.round(INITIAL_GOAL.targetXp * goalXpMultiplier),
        currentXp: 0
    };

    return { tasks, goals: [goal] };
}


/**
 * Hook para manejar la lógica de estado y Firebase de la aplicación.
 */
function useGameData() {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);

    const [totalXp, setTotalXp] = useState(0);
    const [tasks, setTasks] = useState([]);
    const [goals, setGoals] = useState([]);
    const [settings, setSettings] = useState(DEFAULT_SETTINGS);
    const [currentStreak, setCurrentStreak] = useState(0); 
    const [weightHistory, setWeightHistory] = useState([]); 
    const [dailyComplianceHistory, setDailyComplianceHistory] = useState([]); 
    const [isDataLoaded, setIsDataLoaded] = useState(false);
    const [dailySteps, setDailySteps] = useState(0); // Estado para pasos diarios
    const [consumedKcal, setConsumedKcal] = useState(0); // Estado para Calorías Consumidas
    const [dailyStrengthMins, setDailyStrengthMins] = useState(0); // Estado para Minutos de Fuerza

    // Función auxiliar para calcular la edad
    const calculateAge = useCallback((dob) => {
        if (!dob) return null;
        const today = new Date();
        const birthDate = new Date(dob);
        let age = today.getFullYear() - birthDate.getFullYear();
        const monthDifference = today.getMonth() - birthDate.getMonth();
        if (monthDifference < 0 || (monthDifference === 0 && today.getDate() < birthDate.getDate())) {
            age--;
        }
        return age > 0 ? age : null;
    }, []);

    // 1. Inicialización y Autenticación
    useEffect(() => {
        try {
            const app = initializeApp(firebaseConfig);
            const firestoreDb = getFirestore(app);
            const firebaseAuth = getAuth(app);
            setDb(firestoreDb);
            setAuth(firebaseAuth);

            const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
                if (user) {
                    setUserId(user.uid);
                    setIsLoading(false);
                } else {
                    if (initialAuthToken) {
                        await signInWithCustomToken(firebaseAuth, initialAuthToken);
                    } else {
                        await signInAnonymously(firebaseAuth);
                    }
                }
            });

            return () => unsubscribe();
        } catch (err) {
            console.error("Error al inicializar Firebase:", err);
            setError("Error al inicializar la base de datos.");
            setIsLoading(false);
        }
    }, []);

    // 2. Cálculo de Nivel y Progreso
    const currentLevel = useMemo(() => Math.floor(totalXp / XP_PER_LEVEL) + 1, [totalXp]);
    const xpToNextLevel = useMemo(() => XP_PER_LEVEL - (totalXp % XP_PER_LEVEL), [totalXp]);
    const progressPercent = useMemo(() => (totalXp % XP_PER_LEVEL) / XP_PER_LEVEL * 100, [totalXp]);

    // 3. Documento de referencia de Firestore
    const userDocRef = useMemo(() => {
        if (db && userId) {
            // Estructura de 6 segmentos: /artifacts/{appId}/users/{userId}/game_data/progress
            return doc(db, 'artifacts', appId, 'users', userId, 'game_data', 'progress');
        }
        return null;
    }, [db, userId]);

    // 4. Guardar datos en Firestore
    const saveData = useCallback(async (dataToSave) => {
        if (!userDocRef) {
            console.warn("No se puede guardar: La referencia del documento es nula.");
            return;
        }

        try {
            await setDoc(userDocRef, { ...dataToSave, lastUpdated: new Date().toISOString() }, { merge: true });
        } catch (e) {
            console.error("Error al guardar los datos:", e);
            setError("No se pudo guardar el progreso. Inténtalo de nuevo.");
        }
    }, [userDocRef]);

    // 5. Cargar datos desde Firestore (onSnapshot para actualizaciones en tiempo real)
    useEffect(() => {
        if (!userDocRef || !userId) return;

        console.log("Configurando el listener de Firestore para el usuario:", userId);

        const unsubscribe = onSnapshot(userDocRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                setTotalXp(data.totalXp || 0);
                setTasks(data.tasks || []);
                setGoals(data.goals || []);
                setSettings(data.settings || DEFAULT_SETTINGS);
                setCurrentStreak(data.currentStreak || 0);
                setWeightHistory(data.weightHistory || []);
                setDailyComplianceHistory(data.dailyComplianceHistory || []); // Cargar cumplimiento
                setDailySteps(data.dailySteps || 0); // Cargar pasos
                setConsumedKcal(data.consumedKcal || 0); // Cargar calorías consumidas
                setDailyStrengthMins(data.dailyStrengthMins || 0); // Cargar minutos de fuerza
            }
            setIsDataLoaded(true);
        }, (err) => {
            console.error("Error en onSnapshot:", err);
            setError("Error al escuchar actualizaciones de la base de datos.");
            setIsDataLoaded(true);
        });

        return () => unsubscribe();
    }, [userDocRef, userId]);

    // --- Lógica de la aplicación ---

    const startJourney = useCallback((newSettings) => {
        // Calcular edad
        const age = calculateAge(newSettings.dob);
        // Calcular TMB
        const tmb = calculateTMB(newSettings.initialWeight, newSettings.heightCm, age, newSettings.sex);
        // Calcular GET y Meta Calórica
        const { get, caloricGoal } = calculateCaloricGoals(tmb, newSettings.activityLevel);

        const settingsWithCalcs = { 
            ...newSettings, 
            age, 
            tmb, 
            get, 
            caloricGoal 
        };

        const { tasks: initialTasks, goals: initialGoals } = calculateInitialMissions(newSettings.difficulty, settingsWithCalcs);
        
        const dataToSave = {
            totalXp: 0,
            tasks: initialTasks,
            goals: initialGoals,
            settings: settingsWithCalcs, // Guardar la configuración completa con los cálculos
            currentStreak: 0,
            weightHistory: [],
            dailyComplianceHistory: [],
            dailySteps: 0,
            consumedKcal: 0, // Iniciar en cero
            dailyStrengthMins: 0, // Iniciar en cero
        };

        setSettings(settingsWithCalcs);
        setTasks(initialTasks);
        setGoals(initialGoals);
        setCurrentStreak(0);
        setWeightHistory([]);
        setDailyComplianceHistory([]);
        setDailySteps(0);
        setConsumedKcal(0);
        setDailyStrengthMins(0);
        saveData(dataToSave);
    }, [saveData, calculateAge]);
    
    /**
     * Permite al usuario cambiar el plan de dificultad en cualquier momento.
     * Regenera las misiones manteniendo el progreso (XP, racha).
     */
    const changeDifficulty = useCallback((newDifficulty) => {
        if (!isDataLoaded || newDifficulty === settings.difficulty) return;
        
        // 1. Recalcular misiones usando la configuración existente (que ya tiene el GET/TMB)
        const { tasks: newTasks, goals: newGoals } = calculateInitialMissions(newDifficulty, settings);

        // 2. Actualizar configuración
        const newSettings = { ...settings, difficulty: newDifficulty };

        // 3. Crear datos a guardar
        const dataToSave = {
            totalXp,
            tasks: newTasks, // Nuevas misiones
            goals: newGoals, // Nuevas metas
            settings: newSettings,
            currentStreak,
            weightHistory,
            dailyComplianceHistory,
            dailySteps,
            consumedKcal,
            dailyStrengthMins,
        };

        // 4. Actualizar estados locales y guardar
        setSettings(newSettings);
        setTasks(newTasks);
        setGoals(newGoals);
        saveData(dataToSave);
        console.warn(`Dificultad cambiada a: ${newDifficulty}. Las misiones se han regenerado.`);

    }, [totalXp, currentStreak, weightHistory, dailyComplianceHistory, settings, isDataLoaded, saveData, dailySteps, consumedKcal, dailyStrengthMins]);


    const completeTask = useCallback((taskId) => {
        if (!isDataLoaded) return;

        const taskIndex = tasks.findIndex(t => t.id === taskId);
        if (taskIndex === -1 || tasks[taskIndex].isCompleted) return;

        const task = tasks[taskIndex];
        const newTasks = [...tasks];
        newTasks[taskIndex] = { ...task, isCompleted: true };

        const newXp = totalXp + task.xpValue;
        
        const newGoals = goals.map((g, index) => 
            index === 0 ? { ...g, currentXp: Math.min(newXp, g.targetXp) } : g
        );

        setTasks(newTasks);
        setTotalXp(newXp);
        setGoals(newGoals);
        saveData({ totalXp: newXp, tasks: newTasks, goals: newGoals, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps, consumedKcal, dailyStrengthMins });
    }, [totalXp, tasks, goals, saveData, isDataLoaded, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps, consumedKcal, dailyStrengthMins]);

    /**
     * Lógica de Reinicio y Racha: Fin del Día.
     */
    const resetTasks = useCallback(() => {
        if (!isDataLoaded) return;
        
        const completedCount = tasks.filter(t => t.isCompleted).length;
        const totalCount = tasks.length;
        const complianceScore = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
        const allTasksCompleted = complianceScore === 100;

        // Registrar el cumplimiento diario antes de reiniciar
        const today = new Date().toISOString().split('T')[0];
        // Verificar si ya existe una entrada para hoy para evitar duplicados en la historia al hacer múltiples resets
        const historyExistsToday = dailyComplianceHistory.some(entry => entry.date === today);
        let newComplianceHistory;
        
        if (historyExistsToday) {
             // Actualizar la entrada de hoy
             newComplianceHistory = dailyComplianceHistory.map(entry => entry.date === today ? { date: today, score: complianceScore } : entry);
        } else {
             // Añadir nueva entrada
             newComplianceHistory = [...dailyComplianceHistory, { date: today, score: complianceScore }];
        }
        
        let newStreak = currentStreak;
        if (allTasksCompleted) {
            newStreak += 1; // Racha exitosa
        } else {
            newStreak = 0; // Racha rota, castigo por inconsistencia
        }

        const newTasks = tasks.map(t => ({ ...t, isCompleted: false }));
        
        setCurrentStreak(newStreak);
        setTasks(newTasks);
        setDailyComplianceHistory(newComplianceHistory);
        setDailySteps(0); // Reiniciar pasos al final del día
        setConsumedKcal(0); // Reiniciar calorías consumidas al final del día
        setDailyStrengthMins(0); // Reiniciar minutos de fuerza al final del día
        saveData({ 
            totalXp, 
            tasks: newTasks, 
            goals, 
            settings, 
            currentStreak: newStreak, 
            weightHistory, 
            dailyComplianceHistory: newComplianceHistory, 
            dailySteps: 0, 
            consumedKcal: 0, // Valor forzado a 0 para el nuevo día
            dailyStrengthMins: 0 // Valor forzado a 0 para el nuevo día
        });
    }, [tasks, totalXp, goals, saveData, isDataLoaded, settings, currentStreak, weightHistory, dailyComplianceHistory]);

    const logWeight = useCallback((weight) => {
        if (!isDataLoaded) return;
        const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        
        // Evitar duplicados del mismo día
        const updatedHistory = weightHistory.filter(entry => entry.date !== date);
        const newWeightHistory = [...updatedHistory, { date, weight: parseFloat(weight) }];
        
        setWeightHistory(newWeightHistory);
        saveData({ totalXp, tasks, goals, settings, currentStreak, weightHistory: newWeightHistory, dailyComplianceHistory, dailySteps, consumedKcal, dailyStrengthMins });

        // Marcar la misión de registro de peso como completa si existe
        const weightLogTask = tasks.find(t => t.name.includes('Registrar Peso Corporal'));
        if (weightLogTask && !weightLogTask.isCompleted) {
            completeTask(weightLogTask.id);
        }

    }, [weightHistory, saveData, totalXp, tasks, goals, settings, currentStreak, isDataLoaded, dailyComplianceHistory, completeTask, dailySteps, consumedKcal, dailyStrengthMins]);

    const logSteps = useCallback((steps) => {
        if (!isDataLoaded) return;
        // CORRECCIÓN: Usar parseInt con un fallback de 0 para manejar la entrada inicial vacía ('')
        const stepsValue = parseInt(steps, 10) || 0; 

        // 1. **CORRECCIÓN CRÍTICA DE LATENCIA (1):** Actualizar el estado local de pasos ANTES de guardar.
        setDailySteps(stepsValue);

        // 2. **CORRECCIÓN CRÍTICA DE LATENCIA (2):** Integrar la lógica de completado de misión aquí.
        const stepsTask = tasks.find(t => t.type === 'steps');
        if (stepsTask) {
            const isGoalMet = stepsValue >= stepsTask.target;
            const taskIndex = tasks.findIndex(t => t.type === 'steps');
            
            if (taskIndex !== -1 && isGoalMet && !stepsTask.isCompleted) {
                // Forzar la actualización local del array de tareas para la UI instantánea
                const newTasks = tasks.map((t, index) => 
                    index === taskIndex ? { ...t, isCompleted: true } : t
                );
                setTasks(newTasks);
                
                // Sumar XP
                const newXp = totalXp + stepsTask.xpValue;
                setTotalXp(newXp);
                
                // Ahora guardar el estado completo, incluyendo el XP y las tareas actualizadas
                saveData({ 
                    totalXp: newXp, 
                    tasks: newTasks, 
                    goals, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps: stepsValue, consumedKcal, dailyStrengthMins 
                });
                return; // Evitar el saveData genérico de abajo
            }
        }


        saveData({ totalXp, tasks, goals, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps: stepsValue, consumedKcal, dailyStrengthMins });

    }, [saveData, totalXp, tasks, goals, settings, currentStreak, weightHistory, dailyComplianceHistory, isDataLoaded, consumedKcal, dailyStrengthMins]);
    
    // NUEVA FUNCIÓN: Registro de Minutos de Fuerza
    const logStrengthMins = useCallback((mins) => {
        if (!isDataLoaded) return;
        const minsValue = parseInt(mins, 10) || 0;

        // 1. **CORRECCIÓN CRÍTICA DE LATENCIA:** Actualizar el estado local ANTES de la llamada asíncrona a Firestore
        setDailyStrengthMins(minsValue);

        // 2. Integrar la lógica de completado de misión aquí.
        const strengthTask = tasks.find(t => t.type === 'strength');
        if (strengthTask) {
            const isGoalMet = minsValue >= strengthTask.targetMins;
            const taskIndex = tasks.findIndex(t => t.type === 'strength');

            if (taskIndex !== -1 && isGoalMet && !strengthTask.isCompleted) {
                 // Forzar la actualización local del array de tareas para la UI instantánea
                 const newTasks = tasks.map((t, index) => 
                    index === taskIndex ? { ...t, isCompleted: true } : t
                );
                setTasks(newTasks);
                
                // Sumar XP
                const newXp = totalXp + strengthTask.xpValue;
                setTotalXp(newXp);

                // Ahora guardar el estado completo, incluyendo el XP y las tareas actualizadas
                saveData({ 
                    totalXp: newXp, 
                    tasks: newTasks, 
                    goals, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps, consumedKcal, dailyStrengthMins: minsValue
                });
                return;
            }
        }


        saveData({ totalXp, tasks, goals, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps, consumedKcal, dailyStrengthMins: minsValue });
        
    }, [saveData, totalXp, tasks, goals, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps, consumedKcal]);

    // Registro de Calorías Consumidas
    const logConsumedKcal = useCallback((kcal) => {
        if (!isDataLoaded) return;
        // CORRECCIÓN: Usar parseInt con un fallback de 0 para manejar la entrada inicial vacía ('')
        const kcalValue = parseInt(kcal, 10) || 0; 

        // 1. **CORRECCIÓN CRÍTICA DE LATENCIA:** Actualizar el estado local ANTES de la llamada asíncrona a Firestore
        setConsumedKcal(kcalValue);

        saveData({ totalXp, tasks, goals, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps, consumedKcal: kcalValue, dailyStrengthMins });
        
    }, [saveData, totalXp, tasks, goals, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps, isDataLoaded, dailyStrengthMins]);


    const addTask = useCallback((name, xpValue) => {
        if (!isDataLoaded) return;
        const newTask = {
            id: crypto.randomUUID(),
            name,
            xpValue: parseInt(xpValue, 10),
            isCompleted: false,
        };
        const newTasks = [...tasks, newTask];
        setTasks(newTasks);
        saveData({ totalXp, tasks: newTasks, goals, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps, consumedKcal, dailyStrengthMins });
    }, [totalXp, tasks, goals, saveData, isDataLoaded, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps, consumedKcal, dailyStrengthMins]);

    const removeTask = useCallback((taskId) => {
        if (!isDataLoaded) return;
        const newTasks = tasks.filter(t => t.id !== taskId);
        setTasks(newTasks);
        saveData({ totalXp, tasks: newTasks, goals, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps, consumedKcal, dailyStrengthMins });
    }, [totalXp, tasks, goals, saveData, isDataLoaded, settings, currentStreak, weightHistory, dailyComplianceHistory, dailySteps, consumedKcal, dailyStrengthMins]);

    // Cálculo del promedio de cumplimiento de los últimos 7 días
    const averageCompliance = useMemo(() => {
        if (dailyComplianceHistory.length === 0) return 0;
        
        const last7Days = dailyComplianceHistory.slice(-7);
        const sum = last7Days.reduce((acc, entry) => acc + entry.score, 0);
        return Math.round(sum / last7Days.length);
    }, [dailyComplianceHistory]);

    return {
        isLoading: isLoading || !userId || !isDataLoaded,
        error,
        totalXp,
        currentLevel,
        xpToNextLevel,
        progressPercent,
        tasks,
        goals,
        settings,
        currentStreak,
        weightHistory,
        dailyComplianceHistory,
        averageCompliance, // Exportar la nueva métrica
        dailySteps, // Exportar pasos
        consumedKcal, // Exportar calorías consumidas
        dailyStrengthMins, // Exportar minutos de fuerza
        startJourney,
        completeTask,
        resetTasks,
        addTask,
        removeTask,
        logWeight,
        logSteps, // Exportar función de pasos
        logConsumedKcal, // Exportar función de calorías consumidas
        logStrengthMins, // Exportar función de fuerza
        changeDifficulty, // Exportar nueva función
        userId,
    };
}

// --- Componentes de la UI ---

/** Formulario de Registro de Minutos de Fuerza (NUEVO) */
const StrengthMinsLogForm = ({ logStrengthMins, strengthTask, currentStrengthMins }) => {
    // CORRECCIÓN: Usar String(currentStrengthMins || '') para manejar el 0 inicial
    const [mins, setMins] = useState(String(currentStrengthMins || '')); 
    const [message, setMessage] = useState('');
    const target = strengthTask?.targetMins || 0;
    const isCompleted = currentStrengthMins >= target && target > 0;
    
    useEffect(() => {
        setMins(String(currentStrengthMins || ''));
    }, [currentStrengthMins]);

    const handleSubmit = (e) => {
        e.preventDefault();
        const minsValue = parseInt(mins, 10) || 0;
        if (minsValue >= 0) {
            logStrengthMins(minsValue);
            setMessage(`¡Minutos registrados! Meta: ${target} min.`);
            setTimeout(() => setMessage(''), 3000);
        }
    };
    
    if (!strengthTask) return null; // No mostrar si no hay misión de fuerza
    
    const progressPercent = Math.min(100, (currentStrengthMins / target) * 100);

    return (
        <form onSubmit={handleSubmit} className="p-4 bg-gray-700 rounded-xl space-y-3 shadow-inner mt-4">
            <h4 className="text-lg font-semibold text-white flex items-center">
                <Dumbbell className="w-5 h-5 mr-2 text-indigo-400"/>
                Registro de Fuerza
            </h4>
            <div className="text-sm text-gray-300 mb-2">Meta Hoy: {target} Minutos ({isCompleted ? '¡CUMPLIDA!' : 'PENDIENTE'})</div>
            
            <div className="w-full bg-gray-600 rounded-full h-2 mb-3">
                <div 
                    className={`h-2 rounded-full transition-all duration-500 ease-out ${isCompleted ? 'bg-green-500' : 'bg-yellow-500'}`}
                    style={{ width: `${progressPercent}%` }}
                />
            </div>
            
            <div className="flex space-x-3">
                <input
                    type="number"
                    value={mins}
                    onChange={(e) => setMins(e.target.value)}
                    placeholder={`Minutos de Entrenamiento (Meta: ${target})`}
                    className="flex-grow p-2 rounded-lg bg-gray-900 text-white placeholder-gray-500 border-none focus:ring-indigo-500 focus:border-indigo-500"
                    required
                    min="0"
                />
                <button
                    type="submit"
                    className="p-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-bold transition-colors shadow-md"
                >
                    Guardar
                </button>
            </div>
            {message && <p className="text-sm text-green-400 mt-2">{message}</p>}
        </form>
    );
};


/** Tarjeta de Balance Calórico Diario (Nuevo) - Ahora Resumen Detallado */
const DailyCalorieSummaryCard = ({ initialWeight, caloricGoal, dailySteps, consumedKcal, tasks, settings, dailyStrengthMins }) => {
    // Clave de dependencia removida
    if (!initialWeight || !caloricGoal) return null;
    
    // --- 1. Calcular Gasto Adicional (Bonus) ---
    
    // Pasos
    const stepBurn = calculateStepCalories(dailySteps, initialWeight);
    
    // Fuerza (Usando minutos registrados)
    const strengthBurn = calculateStrengthCalories(dailyStrengthMins, initialWeight, settings.sex);
    
    // Gasto total (Pasos + Fuerza)
    const totalBonusBurn = stepBurn + strengthBurn; 

    // --- 2. Calcular Presupuesto Total y Balance ---

    // Presupuesto Total Disponible: Meta Calórica Base + Bonus de Ejercicio
    const adjustedBudget = caloricGoal + totalBonusBurn; 

    // Balance Final: Presupuesto Ajustado - Consumido
    const finalBalance = adjustedBudget - (consumedKcal || 0);

    // --- 3. Display Formatting ---
    const adjustedBudgetDisplay = adjustedBudget.toFixed(0);
    const consumedKcalDisplay = consumedKcal || 0;
    const finalBalanceDisplay = Math.abs(finalBalance).toFixed(0);

    const balanceType = finalBalance > 0; // True = Déficit (Éxito), False = Exceso (Fracaso)
    const balanceColor = balanceType ? 'text-green-400' : 'text-red-400';
    const balanceIcon = balanceType ? <ArrowDown className='w-4 h-4 mr-1 text-green-500'/> : <ArrowUp className='w-4 h-4 mr-1 text-red-500'/>;

    return (
        <div className="p-4 bg-gray-800 rounded-xl border border-gray-700 shadow-xl mt-4">
            <h4 className="text-xl font-bold text-indigo-300 mb-3 flex items-center">
                <Clock className="w-5 h-5 mr-2 text-red-400"/> Resumen de Balance Calórico Diario
            </h4>
            
            {/* Sección de Presupuesto (Entrada) */}
            <div className="bg-gray-700 p-3 rounded-lg space-y-2 border border-gray-600">
                <h5 className="text-md font-bold text-white mb-2">Presupuesto Calórico (Total Disponible)</h5>
                
                <div className="flex justify-between text-sm text-gray-400">
                    <span>Meta Base para Déficit:</span>
                    <span className="text-white font-medium">{caloricGoal.toFixed(0)} Kcal</span>
                </div>

                <div className="flex justify-between text-sm text-gray-400">
                    <span>Bonus por Pasos:</span>
                    <span className="text-green-300 font-medium">+ {stepBurn} Kcal</span>
                </div>
                
                <div className="flex justify-between text-sm text-gray-400 border-b border-gray-600 pb-2">
                    <span>Bonus por Fuerza ({dailyStrengthMins} min):</span>
                    <span className="text-green-300 font-medium">+ {strengthBurn} Kcal</span>
                </div>

                <div className="flex justify-between font-black text-lg pt-1">
                    <span className="text-indigo-300">Total de Calorías DISPONIBLES:</span>
                    <span className="text-yellow-400">{adjustedBudgetDisplay} Kcal</span>
                </div>
            </div>
            
            {/* Sección de Consumo y Balance */}
            <div className="mt-4 pt-2 border-t border-gray-700">
                <div className="flex justify-between font-bold mb-3">
                    <span className="text-white text-lg">Calorías Consumidas:</span>
                    <span className="text-red-400 text-lg">{consumedKcalDisplay} Kcal</span>
                </div>
                
                <div className="flex justify-between font-black text-xl pt-2 bg-gray-700/50 p-3 rounded-lg">
                    <span className="text-indigo-300">Balance Final ({balanceType ? 'Déficit' : 'Exceso'}):</span>
                    <span className={`flex items-center ${balanceColor} font-black`}>
                        {balanceIcon} {finalBalanceDisplay} Kcal
                    </span>
                </div>
            </div>

            <p className="text-xs text-gray-500 pt-3">
                {balanceType 
                    ? `¡Éxito! Lograste un ahorro calórico extra de ${finalBalanceDisplay} Kcal hoy.`
                    : `Cuidado. Tuviste un exceso de ${finalBalanceDisplay} Kcal, arruinando parte de tu déficit base.`
                }
            </p>
        </div>
    );
};


/** Formulario de Registro de Calorías Consumidas (NUEVO) */
const ConsumedKcalLogForm = ({ logConsumedKcal, currentConsumedKcal }) => {
    // CORRECCIÓN: Usar String(currentConsumedKcal || '') para manejar el 0 inicial
    const [kcal, setKcal] = useState(String(currentConsumedKcal || '')); 
    const [message, setMessage] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        const kcalValue = parseInt(kcal, 10) || 0; // Usar fallback a 0 si la entrada es inválida/vacía
        if (kcalValue >= 0) {
            logConsumedKcal(kcalValue);
            setMessage('¡Calorías registradas! Ver Balance Final.');
            setTimeout(() => setMessage(''), 3000);
        }
    };
    
    // Sincronizar el input con el estado global al resetear
    useEffect(() => {
        setKcal(String(currentConsumedKcal || ''));
    }, [currentConsumedKcal]);


    return (
        <form onSubmit={handleSubmit} className="p-4 bg-gray-700 rounded-xl space-y-3 shadow-inner mt-4">
            <h4 className="text-lg font-semibold text-white flex items-center">
                <Utensils className="w-5 h-5 mr-2 text-indigo-400"/>
                Registro de Calorías Consumidas
            </h4>
            <div className="flex space-x-3">
                <input
                    type="number"
                    value={kcal}
                    onChange={(e) => setKcal(e.target.value)}
                    placeholder={`Kcal Consumidas (Honestidad)`}
                    className="flex-grow p-2 rounded-lg bg-gray-900 text-white placeholder-gray-500 border-none focus:ring-indigo-500 focus:border-indigo-500"
                    required
                    min="0"
                />
                <button
                    type="submit"
                    className="p-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-bold transition-colors shadow-md"
                >
                    <Send className='w-5 h-5'/>
                </button>
            </div>
            {message && <p className="text-sm text-green-400 mt-2">{message}</p>}
        </form>
    );
};


/** Formulario de Registro de Pasos Diario */
const StepsLogForm = ({ logSteps, stepsTask, currentSteps }) => {
    // CORRECCIÓN: Asegurar que el estado inicial del input sea el número o cadena vacía
    const [steps, setSteps] = useState(String(currentSteps || '')); 
    const [message, setMessage] = useState('');
    const target = stepsTask?.target || 0;
    const isCompleted = currentSteps >= target && target > 0;

    useEffect(() => {
        // Sincronizar el input con el estado global al cargar
        setSteps(String(currentSteps || ''));
    }, [currentSteps]);

    const handleSubmit = (e) => {
        e.preventDefault();
        const stepsValue = parseInt(steps, 10) || 0; // Usar fallback a 0 si la entrada es inválida/vacía
        if (stepsValue >= 0) {
            logSteps(stepsValue);
            setMessage(`¡Pasos registrados! Meta: ${target}.`);
            setTimeout(() => setMessage(''), 3000);
        }
    };

    if (!stepsTask) return null; // No mostrar si no hay misión de pasos

    const progressPercent = Math.min(100, (currentSteps / target) * 100);

    return (
        <form onSubmit={handleSubmit} className="p-4 bg-gray-700 rounded-xl space-y-3 shadow-inner mt-4">
            <h4 className="text-lg font-semibold text-white flex items-center">
                <Footprints className="w-5 h-5 mr-2 text-indigo-400"/>
                Registro de Pasos Diarios
            </h4>
            <div className="text-sm text-gray-300 mb-2">Meta Hoy: {target} Pasos ({isCompleted ? '¡CUMPLIDA!' : 'PENDIENTE'})</div>
            
            <div className="w-full bg-gray-600 rounded-full h-2 mb-3">
                <div 
                    className={`h-2 rounded-full transition-all duration-500 ease-out ${isCompleted ? 'bg-green-500' : 'bg-yellow-500'}`}
                    style={{ width: `${progressPercent}%` }}
                />
            </div>

            <div className="flex space-x-3">
                <input
                    type="number"
                    value={steps}
                    onChange={(e) => setSteps(e.target.value)}
                    placeholder={`Pasos (Meta: ${target})`}
                    className="flex-grow p-2 rounded-lg bg-gray-900 text-white placeholder-gray-500 border-none focus:ring-indigo-500 focus:border-indigo-500"
                    required
                    min="0"
                />
                <button
                    type="submit"
                    className="p-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-bold transition-colors shadow-md"
                >
                    Guardar
                </button>
            </div>
            {message && <p className="text-sm text-green-400 mt-2">{message}</p>}
        </form>
    );
};


/** Generador de Menú (Nuevo) */
const MenuGenerator = React.memo(({ caloricGoal, initialWeight, sex }) => {
    if (!caloricGoal || !initialWeight || !sex) {
        return (
            <div className="p-4 bg-red-900/40 rounded-xl text-center text-red-300">
                <XCircle className="w-5 h-5 mx-auto mb-2"/>
                Faltan datos de configuración (Meta Calórica, Peso o Sexo) para generar el menú.
            </div>
        );
    }
    
    const isFemale = sex === 'female';
    const proteinGrams = Math.round(initialWeight * (isFemale ? 1.8 : 2.2));
    const proteinKcal = proteinGrams * 4; // 4 kcal por gramo de proteína
    const remainingKcal = caloricGoal - proteinKcal;
    
    // Simplificación para el resto de macros (Carbohidratos y Grasas)
    // Asumimos un balance saludable con énfasis en proteína
    const fatKcal = Math.round(caloricGoal * 0.25); // 25% de calorías de grasa (saludable)
    const carbKcal = caloricGoal - proteinKcal - fatKcal; // El resto de Carbohidratos
    
    const carbGrams = Math.round(carbKcal / 4);
    const fatGrams = Math.round(fatKcal / 9);

    const menuData = [
        {
            time: 'Desayuno (400-500 Kcal)',
            description: `Alto en proteína (30-40g). Combustible para la mañana.`,
            suggestions: [
                `Opción 1: Batido de Proteína (1 scoop) con leche de almendra y 1 fruta.`,
                `Opción 2: 3 huevos enteros revueltos con espinacas y 1 rebanada de pan integral.`,
            ]
        },
        {
            time: 'Comida (600-750 Kcal)',
            description: `Plato completo. Prioridad: Proteína, Fibra, Carbohidratos de bajo índice glucémico.`,
            suggestions: [
                `Opción 1: 150g de Pollo/Pescado a la plancha, 1 taza de Quinoa o arroz integral, verduras al vapor (brócoli/ejotes).`,
                `Opción 2: Ensalada grande con 1 lata de atún, aguacate y vinagreta ligera.`,
            ]
        },
        {
            time: 'Snack (150-250 Kcal)',
            description: `Evitar el hambre antes de la cena. Necesario solo si tienes más de 4h entre comidas.`,
            suggestions: [
                `Yogurt griego natural (alto en proteína) con 1/2 taza de bayas.`,
                `Un puñado de almendras (30g) y una manzana.`,
            ]
        },
        {
            time: 'Cena (300-500 Kcal)',
            description: `Comida ligera. Enfocada en proteína y vegetales fibrosos.`,
            suggestions: [
                `Opción 1: Sopa de lentejas (proteína vegetal) o crema de verduras ligera con 100g de pavo.`,
                `Opción 2: Salmón al horno con espárragos.`,
            ]
        },
    ];

    return (
        <div className="space-y-4">
            <div className="p-4 bg-indigo-900/50 rounded-xl border border-indigo-700 shadow-xl">
                <h3 className="text-xl font-bold text-indigo-300 flex items-center mb-2">
                    <Hash className="w-5 h-5 mr-2"/> Resumen de Metas Nutricionales
                </h3>
                <div className="grid grid-cols-2 gap-2 text-sm font-semibold">
                    <span className="text-gray-400">Objetivo Calórico:</span> <span className="text-green-400">{caloricGoal} Kcal</span>
                    <span className="text-gray-400">Objetivo Proteína:</span> <span className="text-yellow-400">{proteinGrams}g</span>
                    <span className="text-gray-400">Carbohidratos Aprox:</span> <span className="text-white">{carbGrams}g</span>
                    <span className="text-gray-400">Grasas Aprox:</span> <span className="text-white">{fatGrams}g</span>
                </div>
            </div>

            <h3 className="text-2xl font-bold text-white mb-4 flex items-center"><Utensils className="w-6 h-6 mr-2 text-yellow-400"/> Menú de Ejemplo Diario</h3>
            
            {menuData.map((meal, index) => (
                <div key={index} className="bg-gray-800 p-4 rounded-xl shadow-lg border-l-4 border-yellow-500">
                    <h4 className="text-lg font-bold text-yellow-400 mb-1">{meal.time}</h4>
                    <p className="text-sm text-gray-400 mb-3">{meal.description}</p>
                    <ul className="list-disc list-inside space-y-1 text-gray-200 ml-4">
                        {meal.suggestions.map((s, i) => (
                            <li key={i} className="text-sm">{s}</li>
                        ))}
                    </ul>
                </div>
            ))}
            
            <p className="text-xs text-gray-500 pt-4">
                **ADVERTENCIA:** Este es un menú de ejemplo para alcanzar tus objetivos calóricos y de proteína. Consulta a un nutricionista para un plan dietético médico personalizado.
            </p>
        </div>
    );
});


/** Tarjeta de Tasa de Cumplimiento (Nueva) */
const ComplianceRateCard = React.memo(({ averageCompliance }) => (
    <div className="p-4 bg-gray-800 rounded-xl border border-gray-700 shadow-xl">
        <h4 className="text-xl font-bold text-indigo-300 mb-2 flex items-center">
            <Percent className="w-5 h-5 mr-2 text-yellow-400"/> Tasa de Cumplimiento (7 Días)
        </h4>
        <div className="text-4xl font-black text-white">
            {averageCompliance}%
        </div>
        <p className="text-sm text-gray-400 mt-1">
            {averageCompliance >= 90 
                ? '¡EJECUCIÓN ÉLITE! Tu plan está funcionando. Si el peso no baja, ajusta las calorías.'
                : averageCompliance >= 70
                ? 'Consistencia Media. Hay días débiles. La ejecución es el punto ciego.'
                : 'RIESGO ALTO. No estás cumpliendo ni el 70%. Deja de culpar al plan; el problema es la ejecución.'
            }
        </p>
    </div>
));


/** Formulario de Registro de Peso Diario */
const WeightLogForm = ({ logWeight, lastWeight }) => {
    const [weight, setWeight] = useState(lastWeight ? String(lastWeight) : '');
    const [message, setMessage] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (weight > 0) {
            logWeight(weight);
            setMessage('¡Peso registrado! Misión completada.');
            setTimeout(() => setMessage(''), 3000);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="p-4 bg-gray-700 rounded-xl space-y-3 shadow-inner">
            <h4 className="text-lg font-semibold text-white flex items-center"><Weight className="w-5 h-5 mr-2 text-indigo-400"/> Registro de Peso Diario</h4>
            <div className="flex space-x-3">
                <input
                    type="number"
                    step="0.1"
                    value={weight}
                    onChange={(e) => setWeight(e.target.value)}
                    placeholder="Peso (kg)"
                    className="flex-grow p-2 rounded-lg bg-gray-900 text-white placeholder-gray-500 border-none focus:ring-indigo-500 focus:border-indigo-500"
                    required
                    min="1"
                />
                <button
                    type="submit"
                    className="p-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-bold transition-colors shadow-md"
                >
                    Registrar
                </button>
            </div>
            {message && <p className="text-sm text-green-400 mt-2">{message}</p>}
        </form>
    );
};

// Función de utilidad para calcular el promedio móvil de peso
const calculateMobileAverage = (history, days = 7) => {
    if (history.length === 0) return null;
    
    // Ordenar historial por fecha para asegurar el cálculo correcto
    const sortedHistory = [...history].sort((a, b) => new Date(a.date) - new Date(b.date));
    
    // Obtener las últimas N entradas (donde N = days)
    const lastNDays = sortedHistory.slice(-days);
    
    if (lastNDays.length === 0) return null;

    const sum = lastNDays.reduce((acc, entry) => acc + entry.weight, 0);
    return (sum / lastNDays.length).toFixed(1);
};


/** Gráfico de Peso (Simulación simple) */
const WeightChart = React.memo(({ weightHistory, initialWeight }) => {
    // Calcular el Promedio Móvil de 7 Días
    const mobileAverage = calculateMobileAverage(weightHistory, 7);
    
    // Si no hay historial, muestra un mensaje
    if (weightHistory.length === 0) {
        return (
            <div className="p-4 bg-gray-700/50 rounded-xl text-center text-gray-400">
                <BarChart3 className="w-6 h-6 mx-auto mb-2"/>
                Registra tu peso para ver el progreso. (Peso Inicial: {initialWeight}kg)
            </div>
        );
    }
    
    // Simplificación para mostrar el progreso en texto
    const sortedHistory = [...weightHistory].sort((a, b) => new Date(a.date) - new Date(b.date));
    const startWeight = initialWeight || sortedHistory[0].weight;
    const currentWeight = sortedHistory[sortedHistory.length - 1].weight;
    const diff = startWeight - currentWeight;
    const trend = diff > 0 ? `Bajas ${diff.toFixed(1)} kg` : diff < 0 ? `Subes ${Math.abs(diff).toFixed(1)} kg` : 'Estable';

    return (
        <div className="p-4 bg-gray-800 rounded-xl border border-gray-700">
            <h4 className="text-xl font-bold text-indigo-300 mb-3 flex items-center">
                <TrendingUp className="w-5 h-5 mr-2 text-green-400"/> Tu Progreso de Peso
            </h4>
            
            <div className="flex justify-between text-lg font-semibold mb-2">
                <p className="text-gray-400 flex items-center"><Hash className="w-4 h-4 mr-1 text-gray-500"/> Promedio Móvil (7 días):</p>
                <p className={`${mobileAverage && mobileAverage < startWeight ? 'text-green-500' : 'text-yellow-500'} font-black`}>
                    {mobileAverage || 'N/A'} kg
                </p>
            </div>
            
            <div className="flex justify-between text-lg font-semibold mb-2">
                <p className="text-gray-400">Inicio:</p>
                <p className="text-white">{startWeight.toFixed(1)} kg</p>
            </div>
            
            <div className="flex justify-between text-lg font-semibold mb-4">
                <p className="text-gray-400">Peso de Hoy:</p>
                <p className={`${diff > 0 ? 'text-green-500' : diff < 0 ? 'text-red-500' : 'text-yellow-500'}`}>{currentWeight.toFixed(1)} kg</p>
            </div>
            
            <p className="text-sm text-center bg-gray-700 p-2 rounded-lg font-medium">
                Tendencia: <span className="font-bold">{trend}</span> (desde el inicio).
            </p>
        </div>
    );
});


/** Lógica de recomendación de dificultad basada en IMC */
const calculateBMI = (weight, heightCm) => {
    const w = parseFloat(weight);
    const h = parseFloat(heightCm) / 100; // cm a m
    if (w > 0 && h > 0) {
        return (w / (h * h)).toFixed(1);
    }
    return null;
};

const calculateAge = (dob) => {
    if (!dob) return null;
    const today = new Date();
    const birthDate = new Date(dob);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDifference = today.getMonth() - birthDate.getMonth();
    if (monthDifference < 0 || (monthDifference === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }
    return age > 0 && age < 120 ? age : null;
};

const calculateRecommendedDifficulty = (bmiValue, age) => {
    if (!bmiValue || !age) return 'medium'; // Default si faltan datos
    const bmiFloat = parseFloat(bmiValue);
    
    // Obesidad: Start Easy (mínima fricción y máxima consistencia)
    if (bmiFloat >= 30.0) return 'easy'; 
    
    // Sobrepeso y Saludable: Medium (puede manejar más desafío)
    if (bmiFloat >= 25.0) return 'medium'; 
    
    // Bajo Peso (o Saludable): Medium
    return 'medium'; 
};


/** Tarjeta de Calorías y Análisis (Nuevo) */
const CalorieAnalysisCard = React.memo(({ caloricGoal }) => (
    <div className="p-4 bg-gray-800 rounded-xl border border-gray-700 shadow-xl mt-4">
        <h4 className="text-xl font-bold text-indigo-300 mb-3 flex items-center">
            <Calculator className="w-5 h-5 mr-2 text-pink-400"/> Meta Calórica
        </h4>
        <div className="space-y-2">
            <div className="flex justify-between font-black text-lg pt-2">
                <span className="text-indigo-300">Meta Calórica Diaria:</span>
                <span className="text-green-400">{caloricGoal || 'N/A'} Kcal</span>
            </div>
            <p className="text-xs text-gray-500 pt-2">
                Esta es la cifra MÁXIMA que debes consumir. Ya incluye tu déficit.
            </p>
        </div>
    </div>
));


/** Formulario de Onboarding Inicial */
const OnboardingForm = ({ startJourney }) => {
    const [step, setStep] = useState(1);
    const [formData, setFormData] = useState({
        initialWeight: '', heightCm: '', activityLevel: 'light', waterGoal: '3', sleepGoal: '7.5', difficulty: '',
        dob: '', 
        sex: '', 
    });

    // Estados para la recomendación visual
    const [recommendedDifficulty, setRecommendedDifficulty] = useState(null);
    const [showRecommendation, setShowRecommendation] = useState(false);

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    // Lógica de cálculo y recomendación al cargar el Paso 2
    useEffect(() => {
        if (step === 2 && !recommendedDifficulty) {
            const bmiValue = calculateBMI(formData.initialWeight, formData.heightCm);
            const ageValue = calculateAge(formData.dob);
            const recommendation = calculateRecommendedDifficulty(bmiValue, ageValue);

            setRecommendedDifficulty(recommendation);
            setShowRecommendation(true);

            // Temporizador para el "nudge" (5 segundos)
            const timer = setTimeout(() => {
                setShowRecommendation(false);
            }, 5000); 

            return () => clearTimeout(timer);
        }
    }, [step, formData, recommendedDifficulty]);


    const handleStart = (difficulty) => {
        const finalSettings = {
            ...formData,
            difficulty,
            initialWeight: parseFloat(formData.initialWeight) || 0,
            heightCm: parseFloat(formData.heightCm) || 0,
            waterGoal: parseFloat(formData.waterGoal) || 3,
            sleepGoal: parseFloat(formData.sleepGoal) || 7.5,
        };
        startJourney(finalSettings);
    };
    
    // Cálculos para mostrar en la interfaz
    const bmi = useMemo(() => calculateBMI(formData.initialWeight, formData.heightCm), [formData.initialWeight, formData.heightCm]);
    const ageDisplay = useMemo(() => calculateAge(formData.dob), [formData.dob]);
    
    const tmbCalc = useMemo(() => calculateTMB(formData.initialWeight, formData.heightCm, ageDisplay, formData.sex), 
        [formData.initialWeight, formData.heightCm, ageDisplay, formData.sex]
    );
    const { get: getCalc, caloricGoal: caloricGoalCalc } = useMemo(() => calculateCaloricGoals(tmbCalc, formData.activityLevel), 
        [tmbCalc, formData.activityLevel]
    );

    // Función para obtener la clasificación del IMC
    const getBmiCategory = (bmiValue) => {
        if (!bmiValue) return { label: 'Esperando datos', color: 'text-gray-400' };
        const bmiFloat = parseFloat(bmiValue);
        if (bmiFloat < 18.5) return { label: 'Bajo Peso', color: 'text-yellow-400' };
        if (bmiFloat >= 18.5 && bmiFloat < 25) return { label: 'Peso Saludable', color: 'text-green-500' };
        if (bmiFloat >= 25 && bmiFloat < 30) return { label: 'Sobrepeso', color: 'text-orange-500' };
        if (bmiFloat >= 30) return { label: 'Obesidad', color: 'text-red-500' };
        return { label: 'Inválido', color: 'text-gray-400' };
    };

    const bmiCategory = getBmiCategory(bmi);
    
    const renderStep = () => {
        switch (step) {
            case 1:
                const isStep1Complete = formData.initialWeight && formData.heightCm && formData.dob && formData.sex && formData.activityLevel;
                return (
                    <div className="space-y-6">
                        <h2 className="text-2xl font-bold text-white">Paso 1: Datos Biométricos y Gasto</h2>
                        <p className="text-gray-400">Estos datos son la base de tu plan calórico.</p>
                        
                        <div className="bg-gray-700 p-4 rounded-xl space-y-4">
                            
                            {/* Peso, Altura, Fecha, Sexo */}
                            <div className="grid grid-cols-2 gap-4">
                                <label className="block">
                                    <span className="text-sm font-medium text-gray-300 flex items-center mb-1"><Scale className="w-4 h-4 mr-2"/> Peso (kg):</span>
                                    <input
                                        type="number"
                                        name="initialWeight"
                                        value={formData.initialWeight}
                                        onChange={handleChange}
                                        className="w-full p-3 rounded-lg bg-gray-900 text-white placeholder-gray-500 border-none focus:ring-indigo-500 focus:border-indigo-500"
                                        placeholder="Ej: 90"
                                        required
                                        min="1"
                                    />
                                </label>
                                <label className="block">
                                    <span className="text-sm font-medium text-gray-300 flex items-center mb-1"><Activity className="w-4 h-4 mr-2"/> Altura (cm):</span>
                                    <input
                                        type="number"
                                        name="heightCm"
                                        value={formData.heightCm}
                                        onChange={handleChange}
                                        className="w-full p-3 rounded-lg bg-gray-900 text-white placeholder-gray-500 border-none focus:ring-indigo-500 focus:border-indigo-500"
                                        placeholder="Ej: 175"
                                        required
                                        min="1"
                                    />
                                </label>
                            </div>
                            
                            <label className="block">
                                <span className="text-sm font-medium text-gray-300 flex items-center mb-1"><Cake className="w-4 h-4 mr-2"/> Fecha de Nacimiento:</span>
                                <input
                                    type="date"
                                    name="dob"
                                    value={formData.dob}
                                    onChange={handleChange}
                                    className="w-full p-3 rounded-lg bg-gray-900 text-white placeholder-gray-500 border-none focus:ring-indigo-500 focus:border-indigo-500"
                                    required
                                    max={new Date().toISOString().split('T')[0]} 
                                />
                            </label>
                            
                            <div className="grid grid-cols-2 gap-4">
                                <div className="block">
                                    <span className="text-sm font-medium text-gray-300 flex items-center mb-2"><Heart className="w-4 h-4 mr-2"/> Sexo:</span>
                                    <div className="flex space-x-4">
                                        <label className="flex items-center text-white">
                                            <input
                                                type="radio"
                                                name="sex"
                                                value="male"
                                                checked={formData.sex === 'male'}
                                                onChange={handleChange}
                                                className="form-radio text-indigo-500 bg-gray-900 border-gray-600 focus:ring-indigo-500"
                                                required
                                            />
                                            <span className="ml-2">Hombre</span>
                                        </label>
                                        <label className="flex items-center text-white">
                                            <input
                                                type="radio"
                                                name="sex"
                                                value="female"
                                                checked={formData.sex === 'female'}
                                                onChange={handleChange}
                                                className="form-radio text-indigo-500 bg-gray-900 border-gray-600 focus:ring-indigo-500"
                                                required
                                            />
                                            <span className="ml-2">Mujer</span>
                                        </label>
                                    </div>
                                </div>
                                
                                <label className="block">
                                    <span className="text-sm font-medium text-gray-300 flex items-center mb-1"><Activity className="w-4 h-4 mr-2"/> Nivel de Actividad:</span>
                                    <select
                                        name="activityLevel"
                                        value={formData.activityLevel}
                                        onChange={handleChange}
                                        className="w-full p-3 rounded-lg bg-gray-900 text-white border-none focus:ring-indigo-500 focus:border-indigo-500"
                                        required
                                    >
                                        <option value="sedentary">Sedentario (Poco/Ningún Ejercicio)</option>
                                        <option value="light">Ligero (1-3 días/sem)</option>
                                        <option value="moderate">Moderado (3-5 días/sem)</option>
                                        <option value="heavy">Intenso (6-7 días/sem)</option>
                                        <option value="very_heavy">Muy Intenso (Diario/Trabajo físico)</option>
                                    </select>
                                </label>
                            </div>
                            
                            {/* Resumen Biométrico y Calórico */}
                            <div className="pt-4 border-t border-gray-600">
                                <div className="flex justify-between font-medium">
                                    <span className="text-gray-400">IMC:</span>
                                    <span className={bmiCategory.color}>{bmi || 'N/A'} ({bmiCategory.label})</span>
                                </div>
                                <div className="flex justify-between font-medium">
                                    <span className="text-gray-400">TMB (Consumo Mínimo):</span>
                                    <span className="text-white">{tmbCalc || 'N/A'} Kcal</span>
                                </div>
                                <div className="flex justify-between font-medium">
                                    <span className="text-gray-400">Meta Calórica Objetivo:</span>
                                    <span className="text-green-400 font-bold">{caloricGoalCalc || 'N/A'} Kcal</span>
                                </div>
                            </div>

                        </div>

                        <button 
                            onClick={() => setStep(2)}
                            disabled={!isStep1Complete}
                            className="w-full p-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-white font-bold transition-colors flex items-center justify-center disabled:bg-gray-700"
                        >
                            Siguiente <ChevronRight className="w-5 h-5 ml-2"/>
                        </button>
                    </div>
                );
            case 2:
                const showEasyRec = recommendedDifficulty === 'easy' && showRecommendation;
                const showMediumRec = recommendedDifficulty === 'medium' && showRecommendation;
                const showBrutalRec = recommendedDifficulty === 'brutal' && showRecommendation;
                
                return (
                    <div className="space-y-6">
                        <h2 className="text-2xl font-bold text-white">Paso 2: Compromiso y Dificultad</h2>
                        <p className="text-gray-400">Elige tu nivel de **Honestidad/Ejecución**. Tu recomendación personalizada ya fue mostrada.</p>

                        {/* Opciones de Dificultad */}
                        <DifficultyOption 
                            icon={Coffee} 
                            title="Fácil (Primeros Pasos)" 
                            description="Nutrición, Peso Diario y Mínimo Movimiento (3k pasos). Para crear el hábito."
                            xp="Bajo XP por Tarea"
                            onClick={() => handleStart('easy')}
                            color={showEasyRec ? 'bg-green-400 shadow-2xl shadow-green-400/50 animate-pulse' : 'bg-green-600 hover:bg-green-500'}
                            isRecommended={showEasyRec}
                        />
                        <DifficultyOption 
                            icon={Activity} 
                            title="Medio (Balance Óptimo)" 
                            description="Nutrición, Fuerza y Movimiento. El estándar para resultados consistentes."
                            xp="XP Normal"
                            onClick={() => handleStart('medium')}
                            color={showMediumRec ? 'bg-yellow-400 shadow-2xl shadow-yellow-400/50 animate-pulse' : 'bg-yellow-600 hover:bg-yellow-500'}
                            isRecommended={showMediumRec}
                        />
                        <DifficultyOption 
                            icon={User} 
                            title="Brutal (Brutal Honesty)" 
                            description="Todo lo anterior + Misiones de Sueño/Hidratación. Máxima disciplina y resultados acelerados."
                            xp="Alto XP por Tarea"
                            onClick={() => handleStart('brutal')}
                            color={showBrutalRec ? 'bg-red-400 shadow-2xl shadow-red-400/50 animate-pulse' : 'bg-red-700 hover:bg-red-600'}
                            isRecommended={showBrutalRec}
                        />
                         {showRecommendation && (
                            <div className="text-center p-3 bg-indigo-900/50 text-indigo-300 rounded-xl font-bold">
                                Analizando datos biométricos... (Elige tu plan)
                            </div>
                        )}
                        {!showRecommendation && (
                             <div className="text-center p-3 text-gray-400 rounded-xl">
                                Selecciona el nivel que garantiza tu honestidad al 100%.
                            </div>
                        )}
                    </div>
                );
            default:
                return null;
        }
    };

    return (
        <div className="bg-gray-800 p-6 rounded-xl shadow-2xl max-w-lg mx-auto mt-10">
            <h1 className="text-3xl font-extrabold text-indigo-400 mb-4">¡Bienvenido, Asesor!</h1>
            <p className="text-gray-400 mb-8">El Sistema de Maestría Personal requiere un contrato. **Sé implacable con la verdad.**</p>
            {renderStep()}
        </div>
    );
};

const DifficultyOption = ({ icon: Icon, title, description, xp, onClick, color, isRecommended }) => (
    <button 
        onClick={onClick}
        className={`w-full p-4 rounded-xl text-left transition-all duration-300 transform shadow-lg ${color} 
            hover:scale-[1.02]
        `}
    >
        <div className="flex items-start">
            <Icon className={`w-6 h-6 mr-3 mt-1 ${isRecommended ? 'text-gray-900' : 'text-white'}`}/>
            <div className="flex-grow">
                <p className={`text-xl font-bold ${isRecommended ? 'text-gray-900' : 'text-white'}`}>{title}</p>
                <p className={`text-sm mt-1 ${isRecommended ? 'text-gray-700' : 'text-gray-200'}`}>{description}</p>
                {isRecommended && (
                    <p className="text-sm font-black mt-2 flex items-center text-gray-900 bg-white/70 rounded-full px-2 py-1 self-start">
                        <Lightbulb className="w-4 h-4 mr-1"/> TE RECOMENDAMOS ESTE PLAN
                    </p>
                )}
            </div>
            <div className="text-right ml-4">
                <Zap className={`w-4 h-4 ${isRecommended ? 'text-gray-900' : 'text-yellow-300'}`}/>
                <p className={`text-xs font-semibold ${isRecommended ? 'text-gray-900' : 'text-yellow-300'}`}>{xp}</p>
            </div>
        </div>
    </button>
);


/** Tarjeta de Misión/Tarea */
const TaskCard = React.memo(({ task, onComplete, onRemove }) => (
    <div className={`flex items-center justify-between p-4 mb-2 rounded-xl transition-all ${task.isCompleted ? 'bg-green-900/50 opacity-70' : 'bg-gray-800 hover:bg-gray-700/80'}`}>
        <div className="flex-grow">
            <p className={`font-semibold text-lg ${task.isCompleted ? 'line-through text-gray-400' : 'text-white'}`}>{task.name}</p>
            <p className="text-sm text-yellow-400 flex items-center">
                <Zap className="w-4 h-4 mr-1"/> {task.xpValue} XP
            </p>
        </div>
        <div className="flex space-x-2 ml-4">
            <button
                onClick={() => onComplete(task.id)}
                disabled={task.isCompleted}
                className={`p-3 rounded-full shadow-lg transition-all transform hover:scale-105
                    ${task.isCompleted ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-600 hover:bg-green-500'}
                `}
                aria-label={task.isCompleted ? "Completada" : "Marcar como completada"}
            >
                <Check className="w-5 h-5 text-white" />
            </button>
            <button
                onClick={() => onRemove(task.id)}
                className="p-3 bg-red-600/70 rounded-full shadow-lg hover:bg-red-500 transition-colors"
                aria-label="Eliminar Tarea"
            >
                <Trash2 className="w-5 h-5 text-white" />
            </button>
        </div>
    </div>
));

/** Tarjeta de Objetivo/Meta Grande */
const GoalCard = React.memo(({ goal }) => {
    const progress = Math.min(100, (goal.currentXp / goal.targetXp) * 100);
    const remainingXp = goal.targetXp - goal.currentXp;

    return (
        <div className="bg-gray-800 p-5 rounded-xl shadow-xl mb-4 border-l-4 border-indigo-500">
            <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold text-indigo-300">{goal.name}</h3>
                <Trophy className="w-6 h-6 text-indigo-400" />
            </div>
            <p className="text-sm text-gray-400 mt-1">XP Requerido: {goal.targetXp}</p>
            <div className="mt-3">
                <div className="flex justify-between mb-1 text-sm font-medium text-gray-300">
                    <span>Progreso: {Math.round(progress)}%</span>
                    <span>{remainingXp >= 0 ? `${remainingXp} XP restantes` : '¡Completado!'}</span>
                </div>
                <div className="w-full bg-gray-700 rounded-full h-2.5">
                    <div
                        className="h-2.5 rounded-full bg-indigo-500 transition-all duration-500 ease-out"
                        style={{ width: `${progress}%` }}
                    ></div>
                </div>
            </div>
        </div>
    );
});

/** Formulario para Añadir Tarea/Misión */
function AddTaskForm({ onAdd }) {
    const [name, setName] = useState('');
    const [xpValue, setXpValue] = useState(100);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (name.trim()) {
            onAdd(name.trim(), xpValue);
            setName('');
            setXpValue(100);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="p-4 bg-gray-700 rounded-xl mt-4 space-y-3">
            <h4 className="text-lg font-semibold text-white">Añadir Misión (Tarea Diaria)</h4>
            <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nombre de la Misión (Ej: Escribir el plan de negocios)"
                className="w-full p-2 rounded-lg bg-gray-900 text-white placeholder-gray-500 focus:ring-indigo-500 focus:border-indigo-500 border-none"
                required
            />
            <div className="flex items-center space-x-3">
                <input
                    type="number"
                    value={xpValue}
                    onChange={(e) => setXpValue(Math.max(1, parseInt(e.target.value) || 1))}
                    placeholder="Valor XP"
                    min="1"
                    className="w-1/3 p-2 rounded-lg bg-gray-900 text-white focus:ring-indigo-500 focus:border-indigo-500 border-none"
                    required
                />
                <span className="text-yellow-400">XP</span>
                <button
                    type="submit"
                    className="flex-grow flex items-center justify-center p-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-bold transition-colors"
                >
                    <Plus className="w-5 h-5 mr-2" />
                    Crear Misión
                </button>
            </div>
        </form>
    );
}

// --- Componente de Dashboard Principal ---
const Dashboard = ({ data }) => {
    const {
        totalXp, currentLevel, xpToNextLevel, progressPercent, tasks, goals, userId,
        completeTask, resetTasks, addTask, removeTask, logWeight, logSteps, dailySteps, settings, currentStreak, weightHistory, averageCompliance,
        logConsumedKcal, consumedKcal, logStrengthMins, dailyStrengthMins,
        changeDifficulty // Nuevo prop
    } = data;

    const [activeTab, setActiveTab] = useState('tasks');
    const [showTaskForm, setShowTaskForm] = useState(false);
    const [showDifficultySelector, setShowDifficultySelector] = useState(false); // Nuevo estado para el menú

    const completedTasks = tasks.filter(t => t.isCompleted).length;
    const totalTasks = tasks.length;
    const allTasksCompleted = totalTasks > 0 && completedTasks === totalTasks;
    const lastWeight = weightHistory.length > 0 ? weightHistory[weightHistory.length - 1].weight : settings.initialWeight;
    
    // Encontrar la misión de pasos y fuerza para pasarla a los formularios
    const stepsTask = tasks.find(t => t.type === 'steps');
    const strengthTask = tasks.find(t => t.type === 'strength');

    const difficultyMap = {
        easy: { label: 'FÁCIL', color: 'text-green-400', description: 'Creación de Hábito' },
        medium: { label: 'MEDIO', color: 'text-yellow-400', description: 'Resultados Sólidos' },
        brutal: { label: 'BRUTAL', color: 'text-red-400', description: 'Adherencia Máxima' },
    };

    const currentDifficulty = difficultyMap[settings.difficulty] || { label: 'N/A', color: 'text-gray-400', description: '' };

    const handleDifficultyChange = (newDifficulty) => {
        changeDifficulty(newDifficulty);
        setShowDifficultySelector(false);
    };


    return (
        <div className="min-h-screen bg-gray-900 text-white p-4 sm:p-6 font-sans">
            <header className="mb-6 bg-gray-800 p-4 rounded-xl shadow-2xl border-b-4 border-indigo-600">
                <div className="flex justify-between items-center mb-4">
                    <h1 className="text-3xl font-extrabold text-indigo-400">Maestría Personal</h1>
                    <div className="flex items-center bg-gray-700/50 p-2 rounded-full px-4 shadow-inner">
                        <span className="text-sm text-gray-400 mr-2">UID:</span>
                        <span className="text-sm font-mono text-white break-all">{userId}</span>
                    </div>
                </div>

                {/* Tarjeta de Progreso Principal */}
                <div className="flex items-start space-x-4 mb-4">
                    <div className="text-center p-3 bg-indigo-600 rounded-full shadow-lg">
                        <Trophy className="w-8 h-8 text-white" />
                    </div>
                    <div className="flex-grow">
                        {/* Selector de Dificultad */}
                        <div className="relative inline-block text-left">
                            <button
                                onClick={() => setShowDifficultySelector(!showDifficultySelector)}
                                className="text-sm font-medium text-gray-400 hover:text-white transition-colors flex items-center mb-1 group"
                            >
                                Dificultad: <span className={`ml-1 font-bold ${currentDifficulty.color}`}>{currentDifficulty.label}</span>
                                <Settings className="w-4 h-4 ml-1 text-indigo-400 group-hover:rotate-12 transition-transform"/>
                            </button>
                            {showDifficultySelector && (
                                <div className="absolute left-0 mt-2 w-48 rounded-md shadow-lg bg-gray-700 ring-1 ring-black ring-opacity-5 z-10">
                                    <div className="py-1">
                                        {Object.entries(difficultyMap).map(([key, value]) => (
                                            <button
                                                key={key}
                                                onClick={() => handleDifficultyChange(key)}
                                                className={`w-full text-left px-4 py-2 text-sm font-medium transition-colors 
                                                    ${settings.difficulty === key 
                                                        ? 'bg-indigo-600 text-white' 
                                                        : 'text-gray-200 hover:bg-gray-600'
                                                    }`}
                                            >
                                                {value.label}
                                            </button>
                                        ))}
                                    </div>
                                    <p className="text-xs text-gray-400 p-2 border-t border-gray-600">Advertencia: Cambiar el plan regenera tus misiones.</p>
                                </div>
                            )}
                        </div>
                        {/* Fin Selector */}

                        <p className="text-4xl font-black text-white">Nivel {currentLevel}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-xl font-semibold text-yellow-400 flex items-center justify-end">
                            <Zap className="w-5 h-5 mr-1" /> {totalXp} XP
                        </p>
                        <p className="text-sm text-gray-400">{xpToNextLevel} XP para el Nivel {currentLevel + 1}</p>
                    </div>
                </div>

                {/* Barra de Progreso */}
                <div className="w-full bg-gray-700 rounded-full h-2 mt-4 mb-4">
                    <div
                        className="h-2 rounded-full bg-indigo-500 transition-all duration-500 ease-out"
                        style={{ width: `${progressPercent}%` }}
                    ></div>
                </div>

                {/* Racha */}
                <div className={`p-3 rounded-xl flex items-center justify-between shadow-inner ${currentStreak > 0 ? 'bg-green-900/40 border border-green-700' : 'bg-red-900/40 border border-red-700'}`}>
                    <span className="text-lg font-bold text-white flex items-center">
                        <Flame className="w-6 h-6 mr-2 text-red-400"/>
                        Racha Diaria Actual:
                    </span>
                    <span className={`text-2xl font-black ${currentStreak > 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {currentStreak} {currentStreak === 1 ? 'DÍA' : 'DÍAS'}
                    </span>
                </div>
            </header>
            
            {/* Formularios de Input */}
            <WeightLogForm logWeight={logWeight} lastWeight={lastWeight} />
            {stepsTask && <StepsLogForm logSteps={logSteps} stepsTask={stepsTask} currentSteps={dailySteps} />}
            {strengthTask && <StrengthMinsLogForm logStrengthMins={logStrengthMins} strengthTask={strengthTask} currentStrengthMins={dailyStrengthMins} />}
            <ConsumedKcalLogForm logConsumedKcal={logConsumedKcal} currentConsumedKcal={consumedKcal} />

            {/* Análisis Calórico */}
            <CalorieAnalysisCard caloricGoal={settings.caloricGoal} />
            <DailyCalorieSummaryCard 
                initialWeight={settings.initialWeight} 
                caloricGoal={settings.caloricGoal} 
                dailySteps={dailySteps} 
                consumedKcal={consumedKcal}
                tasks={tasks}
                settings={settings}
                dailyStrengthMins={dailyStrengthMins}
            />


            {/* Navegación por Pestañas */}
            <div className="flex my-6 border-b border-gray-700">
                <button
                    onClick={() => setActiveTab('tasks')}
                    className={`flex-1 py-3 text-center text-lg font-semibold transition-colors ${
                        activeTab === 'tasks' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-400 hover:text-white'
                    }`}
                >
                    Misiones Diarias ({completedTasks}/{totalTasks})
                </button>
                <button
                    onClick={() => setActiveTab('goals')}
                    className={`flex-1 py-3 text-center text-lg font-semibold transition-colors ${
                        activeTab === 'goals' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-400 hover:text-white'
                    }`}
                >
                    Progreso
                </button>
                <button
                    onClick={() => setActiveTab('menu')}
                    className={`flex-1 py-3 text-center text-lg font-semibold transition-colors ${
                        activeTab === 'menu' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-400 hover:text-white'
                    }`}
                >
                    Menú
                </button>
            </div>

            {/* Contenido de las Pestañas */}
            <main>
                {activeTab === 'tasks' && (
                    <section>
                        {tasks.length === 0 && (
                             <p className="text-center text-gray-400 mt-8">
                                 No hay misiones. Añade una para empezar a acumular XP.
                             </p>
                        )}
                        <div className="space-y-3">
                            {tasks.map(task => (
                                <TaskCard key={task.id} task={task} onComplete={completeTask} onRemove={removeTask} />
                            ))}
                        </div>

                        <div className="mt-6 flex space-x-4">
                            <button
                                onClick={resetTasks}
                                className={`flex-1 p-3 rounded-xl text-white font-bold transition-colors shadow-lg 
                                    ${allTasksCompleted ? 'bg-green-700 hover:bg-green-600' : 'bg-red-700 hover:bg-red-600'}
                                `}
                            >
                                {allTasksCompleted ? '¡Racha Salvada! (Reiniciar Misiones)' : 'Reiniciar (¡Racha Perdida!)'}
                            </button>
                            <button
                                onClick={() => setShowTaskForm(!showTaskForm)}
                                className="p-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-white font-bold transition-colors shadow-lg"
                            >
                                {showTaskForm ? 'Ocultar' : 'Añadir'}
                            </button>
                        </div>

                        {showTaskForm && <AddTaskForm onAdd={addTask} />}
                    </section>
                )}

                {activeTab === 'goals' && (
                    <section className="space-y-4">
                        <GoalCard goal={goals[0]} />
                        <ComplianceRateCard averageCompliance={averageCompliance} />
                        <WeightChart weightHistory={weightHistory} initialWeight={settings.initialWeight} />
                    </section>
                )}
                
                {activeTab === 'menu' && (
                    <section>
                        <MenuGenerator 
                            caloricGoal={settings.caloricGoal} 
                            initialWeight={settings.initialWeight} 
                            sex={settings.sex}
                        />
                    </section>
                )}
            </main>
        </div>
    );
}

// --- Componente Principal ---
const App = () => {
    const data = useGameData();
    const { isLoading, error, settings, startJourney } = data;

    if (error) {
        return (
            <div className="min-h-screen bg-gray-900 text-white p-6 flex flex-col items-center justify-center">
                <p className="text-red-500 font-bold">Error Crítico: {error}</p>
                <p className="text-sm text-gray-400 mt-2">No se pudo cargar la aplicación. Revisa la consola para más detalles.</p>
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
                <Loader2 className="w-10 h-10 animate-spin text-indigo-400" />
                <p className="ml-3 text-lg">Cargando Sistema de Maestría...</p>
            </div>
        );
    }
    
    // Si la dificultad no está configurada, mostrar el formulario de Onboarding
    if (!settings.difficulty) {
        return <OnboardingForm startJourney={startJourney} />;
    }

    // Si la configuración existe, mostrar el Dashboard principal
    return <Dashboard data={data} />;
}

export default App;
