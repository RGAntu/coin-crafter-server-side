require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const { default: Stripe } = require("stripe");

const serviceAccount = require("./coin-crafter-firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Stripe with your secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.m3lhrmy.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const db = client.db("coinCrafterDB");
    const usersCollection = db.collection("users");
    const tasksCollection = db.collection("tasks");
    const submissionsCollection = db.collection("submissions");
    const paymentsCollection = db.collection("payments");
    const withdrawalsCollection = db.collection("withdrawals");

    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      const token = authHeader.split(" ")[1];

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        console.error("Token verification error:", error);
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    // Endpoint to save user data
    app.post("/users", async (req, res) => {
      const newUser = req.body;

      if (!newUser?.email) {
        return res.status(400).send({ error: "Email is required." });
      }

      // Check if the user already exists
      const existingUser = await usersCollection.findOne({
        email: newUser.email,
      });

      if (existingUser) {
        return res.status(409).send({ error: "User already exists." });
      }

      // Insert the user
      const result = await usersCollection.insertOne(newUser);
      res.status(201).send(result);
    });

    //  Route to get user role by email
    app.get("/users/role", async (req, res) => {
      const email = req.query.email;
      console.log(email);
      if (!email) {
        return res.status(400).send({ error: "Email query is required." });
      }

      const user = await usersCollection.findOne({ email });
      console.log(user);
      if (!user) {
        return res.status(404).send({ error: "User not found." });
      }

      //  Send only the role (not full user)
      res.send({ role: user.role || "user" });
    });

    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = await db.collection("users").findOne({ email });
      res.send(user);
    });

    app.get("/users/coins/:email", async (req, res) => {
      const email = req.params.email;

      try {
        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }

        res.json({ coins: user.coins || 0 });
      } catch (err) {
        console.error("Failed to fetch coins:", err);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.patch("/users/coins/:email", async (req, res) => {
      const email = req.params.email;
      const { amount } = req.body;
      const result = await db
        .collection("users")
        .updateOne({ email }, { $inc: { coins: amount } });
      res.send(result);
    });

    // Buyer

    // 1. GET Buyer Stats
    app.get("/buyer/stats", async (req, res) => {
      const buyerEmail = req.query.email;
      if (!buyerEmail) return res.status(400).send({ error: "Email required" });

      const totalTasks = await tasksCollection.countDocuments({
        buyer_email: buyerEmail,
      });

      const buyerTasks = await tasksCollection
        .find({ buyer_email: buyerEmail })
        .toArray();
      const pendingWorkers = buyerTasks.reduce(
        (acc, task) => acc + (task.required_workers || 0),
        0
      );

      const paidSubs = await submissionsCollection
        .find({
          buyer_email: buyerEmail,
          status: "approved",
        })
        .toArray();

      const totalPaid = paidSubs.reduce(
        (sum, s) => sum + (s.payable_amount || 0),
        0
      );

      res.send({ totalTasks, pendingWorkers, totalPaid });
    });

    // 2. GET Pending Submissions
    app.get("/buyer/pending-submissions", async (req, res) => {
      const buyerEmail = req.query.email;
      if (!buyerEmail) return res.status(400).send({ error: "Email required" });

      const subs = await submissionsCollection
        .find({
          buyer_email: buyerEmail,
          status: "pending",
        })
        .toArray();

      res.send(subs);
    });

    // GET /submissions/coin-balance
    app.get("/submissions/coin-balance", async (req, res) => {
      const email = req.query.email;
      if (!email) return res.status(400).send({ error: "Email required" });

      const submissions = await submissionsCollection
        .find({ worker_email: email, status: "approved" })
        .toArray();

      const totalCoins = submissions.reduce(
        (sum, s) => sum + (s.payable_amount || 0),
        0
      );

      res.send({ totalCoins });
    });

    // 3. PATCH Approve Submission
    app.patch("/submissions/approve/:id", async (req, res) => {
      const id = req.params.id;
      const sub = await submissionsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!sub) return res.status(404).send({ error: "Not found" });

      await submissionsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved" } }
      );

      await usersCollection.updateOne(
        { email: sub.worker_email },
        { $inc: { coins: sub.payable_amount } }
      );

      res.send({ success: true });
    });

    // 4. PATCH Reject Submission
    app.patch("/submissions/reject/:id", async (req, res) => {
      const id = req.params.id;
      const sub = await submissionsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!sub) return res.status(404).send({ error: "Not found" });

      await submissionsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "rejected" } }
      );

      await tasksCollection.updateOne(
        { _id: new ObjectId(sub.task_id) },
        { $inc: { required_workers: 1 } }
      );

      res.send({ success: true });
    });

    // my task
    app.post("/tasks", verifyFBToken, async (req, res) => {
      try {
        const task = {
          ...req.body,
          created_by: req.decoded.email,
          status: "pending",
          created_at: new Date(),
        };

        const result = await tasksCollection.insertOne(task);
        res.status(201).json({ insertedId: result.insertedId });
      } catch (error) {
        console.error("Error creating task:", error);
        res.status(500).json({ error: "Failed to create task" });
      }
    });

    // GET: My Tasks
    app.get("/tasks/my/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const tasks = await db
        .collection("tasks")
        .find({ created_by: email })
        .sort({ compilation_date: -1 })
        .toArray();
      res.send(tasks);
    });

    // PUT: Update Task
    app.put("/tasks/:id", verifyFBToken, async (req, res) => {
      const { title, task_details, submission_details } = req.body;
      const result = await db.collection("tasks").updateOne(
        { _id: new ObjectId(req.params.id), created_by: req.decoded.email },
        {
          $set: {
            title,
            task_details,
            submission_details,
          },
        }
      );
      res.send(result);
    });

    // DELETE: Delete Task
    app.delete("/tasks/:id", verifyFBToken, async (req, res) => {
      const taskId = req.params.id;
      const email = req.decoded.email;

      const task = await db.collection("tasks").findOne({
        _id: new ObjectId(taskId),
        created_by: email,
      });

      if (!task) return res.status(404).send({ message: "Task not found" });

      const refill = task.required_workers * task.payable_amount;

      const deleteResult = await db
        .collection("tasks")
        .deleteOne({ _id: new ObjectId(taskId) });

      if (deleteResult.deletedCount > 0 && task.status !== "completed") {
        await db
          .collection("users")
          .updateOne({ email }, { $inc: { coins: refill } });
      }

      res.send({ deleted: true, refillAmount: refill });
    });

    // 1. Create Payment Intent
    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;
      if (!amount) {
        return res.status(400).json({ error: "Amount is required" });
      }

      try {
        // Stripe expects amount in cents (e.g. $1 = 100 cents)
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // convert dollars to cents
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Stripe error:", error);
        res.status(500).json({ error: "Failed to create payment intent" });
      }
    });

    // 2. Save payment info and update user's coins
    app.post("/payments", async (req, res) => {
      const { email, amount, transactionId, date, coins } = req.body;

      if (!email || !amount || !transactionId || !coins) {
        return res.status(400).json({ error: "Missing payment info" });
      }

      try {
        // Save payment record
        const paymentDoc = {
          email,
          amount,
          transactionId,
          date: new Date(date),
          coins,
        };
        await paymentsCollection.insertOne(paymentDoc);

        // Update user's coin balance (increment coins)
        const updateResult = await usersCollection.updateOne(
          { email },
          { $inc: { coins: coins } }
        );

        if (updateResult.matchedCount === 0) {
          return res.status(404).json({ error: "User not found" });
        }

        res.json({ message: "Payment saved and coins updated" });
      } catch (error) {
        console.error("Payment saving error:", error);
        res.status(500).json({ error: "Failed to save payment info" });
      }
    });

    //  Route to get payment history
    app.get("/payments/history", async (req, res) => {
      try {
        const email = req.query.email;
        if (!email) {
          return res.status(400).json({ error: "Email is required" });
        }

        const payments = await paymentsCollection
          .find({ email })
          .sort({ date: -1 })
          .toArray();

        res.json(payments);
      } catch (error) {
        console.error("Error fetching payment history:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // Worker
    // GET /workers/top
    app.get("/workers/top", async (req, res) => {
      try {
        // Find top 6 users sorted by coins descending
        // Convert coins to number if stored differently (like {$numberInt: "100"})
        const topWorkers = await usersCollection
          .find({})
          .sort({ coins: -1 }) // Assuming coins is stored as number
          .limit(6)
          .project({ name: 1, photo: 1, coins: 1 }) // Return only needed fields
          .toArray();

        res.send(topWorkers);
      } catch (error) {
        console.error("Error fetching top workers:", error);
        res.status(500).send({ error: "Internal Server Error" });
      }
    });

    app.get("/submissions/worker/:email", async (req, res) => {
      const { email } = req.params;
      try {
        const allSubmissions = await submissionsCollection
          .find({ worker_email: email })
          .toArray();

        const totalSubmissions = allSubmissions.length;
        const pendingSubmissions = allSubmissions.filter(
          (sub) => sub.status === "pending"
        ).length;

        const approvedSubmissions = allSubmissions.filter(
          (sub) => sub.status === "approved"
        );
        const totalEarnings = approvedSubmissions.reduce(
          (sum, sub) => sum + sub.payable_amount,
          0
        );

        res.json({
          totalSubmissions,
          pendingSubmissions,
          totalEarnings,
          approvedSubmissions,
        });
      } catch (err) {
        console.error("Failed to get worker stats:", err);
        res.status(500).json({ error: "Failed to get worker stats" });
      }
    });

    app.get("/submissions/approved", async (req, res) => {
      const { email } = req.query;

      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }

      try {
        const submissions = await submissionsCollection
          .find({ worker_email: email, status: "approved" })
          .sort({ submittedAt: -1 }) // optional: ensure submittedAt field is stored during submission
          .toArray();

        res.json(submissions);
      } catch (error) {
        console.error("Error fetching approved submissions:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/tasks/available", async (req, res) => {
      try {
        const tasks = await client
          .db("coinCrafterDB")
          .collection("tasks")
          .find({ required_workers: { $gt: 0 } })
          .sort({ completion_date: 1 }) // earliest deadline first
          .toArray();

        res.status(200).json(tasks);
      } catch (error) {
        console.error("Error fetching available tasks:", error);
        res.status(500).json({ message: "Server error fetching tasks." });
      }
    });

    // GET task by ID
    app.get("/tasks/:id", async (req, res) => {
      try {
        const task = await client
          .db("coinCrafterDB")
          .collection("tasks")
          .findOne({ _id: new ObjectId(req.params.id) });

        if (!task) return res.status(404).json({ message: "Task not found" });
        res.json(task);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error retrieving task." });
      }
    });

    // POST submission by worker
    app.post("/submissions", async (req, res) => {
      try {
        const {
          task_id,
          task_title,
          payable_amount,
          worker_email,
          submission_details,
          worker_name,
          buyer_name,
          buyer_email,
          current_date,
          status,
        } = req.body;

        if (!task_id || !worker_email || !submission_details || !task_title) {
          return res.status(400).send({ error: "Missing required fields." });
        }

        const newSubmission = {
          task_id: new ObjectId(task_id),
          task_title,
          payable_amount,
          worker_email,
          submission_details,
          worker_name,
          buyer_name,
          buyer_email,
          submittedAt: new Date(current_date),
          status: status || "pending",
        };

        const result = await submissionCollection.insertOne(newSubmission);
        res.send(result);
      } catch (error) {
        console.error("POST /submissions error:", error);
        res.status(500).send({ error: "Failed to submit task." });
      }
    });

    // GET /submissions/worker?email=worker@example.com
    app.get("/submissions/worker", async (req, res) => {
      try {
        const { email } = req.query;
        if (!email)
          return res.status(400).json({ message: "Email is required" });

        const submissions = await client
          .db("coinCrafterDB")
          .collection("submissions")
          .find({ worker_email: email })
          .sort({ submittedAt: -1 })
          .toArray();

        res.json(submissions);
      } catch (err) {
        console.error("Error fetching submissions:", err);
        res.status(500).json({ message: "Error fetching submissions" });
      }
    });

    app.post("/withdrawals", async (req, res) => {
      try {
        const withdrawal = req.body;

        const result = await withdrawalsCollection.insertOne({
          ...withdrawal,
          status: "pending", // Ensure it's marked as pending
        });

        res.status(201).send({ insertedId: result.insertedId });
      } catch (error) {
        console.error("Error processing withdrawal:", error);
        res.status(500).send({ error: "Internal Server Error" });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Coin Crafter is your Micro task and earning platform");
});

app.listen(port, () => {
  console.log(`Coin Crafter is running on port ${port}`);
});
