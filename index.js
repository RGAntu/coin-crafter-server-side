require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const { default: Stripe } = require("stripe");

const createNotification = require("./utils/createNotification");

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

    //  Middleware

    const verifyFBToken = (db) => {
      return async (req, res, next) => {
        const authHeader = req.headers.authorization;

        // No token — send 401
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return res
            .status(401)
            .json({ message: "Unauthorized: No token provided" });
        }

        const token = authHeader.split(" ")[1];

        try {
          // Verify Firebase token
          const decodedToken = await admin.auth().verifyIdToken(token);
          req.decoded = decodedToken;

          // Get user from DB
          const user = await db
            .collection("users")
            .findOne({ email: decodedToken.email });

          if (!user) {
            return res.status(404).json({ message: "User not found" });
          }

          // Attach role for role-based middleware
          req.decoded.role = user.role;

          next();
        } catch (error) {
          console.error("Token verification error:", error.message);
          return res.status(400).json({ message: "Invalid token" });
        }
      };
    };

    //  verifyAdmin
    const verifyAdmin = async (req, res, next) => {
      const requesterEmail = req.decoded.email;

      const user = await db
        .collection("users")
        .findOne({ email: requesterEmail });

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden: Admins only" });
      }

      next();
    };

    //verifyBuyer
    const verifyBuyer = async (req, res, next) => {
      const requesterEmail = req.decoded.email;

      const user = await db
        .collection("users")
        .findOne({ email: requesterEmail });

      if (!user || user.role !== "buyer") {
        return res.status(403).send({ message: "Forbidden: Buyers only" });
      }

      next();
    };

    // verifyWorker
    const verifyWorker = async (req, res, next) => {
      const requesterEmail = req.decoded.email;

      const user = await db
        .collection("users")
        .findOne({ email: requesterEmail });

      if (!user || user.role !== "worker") {
        return res.status(403).send({ message: "Forbidden: Workers only" });
      }

      next();
    };

    // GET all tasks (Admin Only)
    app.get("/tasks", verifyFBToken(db), async (req, res) => {
      if (req.decoded.role !== "admin") {
        return res.status(403).send({ message: "Admins only" });
      }

      const tasks = await db.collection("tasks").find().toArray();
      res.send(tasks);
    });

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

    //  ------------------ Buyer --------------------

    // 1. GET Buyer Stats
    app.get(
      "/buyer/stats",
      verifyFBToken(db),
      verifyBuyer,
      async (req, res) => {
        const buyerEmail = req.query.email;
        if (!buyerEmail)
          return res.status(400).send({ error: "Email required" });

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
      }
    );

    // 2. GET Pending Submissions
    app.get(
      "/buyer/pending-submissions",
      verifyFBToken(db),
      verifyBuyer,
      async (req, res) => {
        const buyerEmail = req.query.email;
        if (!buyerEmail)
          return res.status(400).send({ error: "Email required" });

        const subs = await submissionsCollection
          .find({
            buyer_email: buyerEmail,
            status: "pending",
          })
          .toArray();

        res.send(subs);
      }
    );

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

   

    // PATCH: Approve or Reject Submission Status
    app.patch(
      "/submissions/update-status/:id",
      verifyFBToken(db),
      verifyBuyer,
      async (req, res) => {
        const { id } = req.params;
        const { status } = req.body;
        const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@microtask.com";

        if (!["approved", "rejected"].includes(status)) {
          return res.status(400).send({ error: "Invalid status value" });
        }

        try {
          const submission = await submissionsCollection.findOne({
            _id: new ObjectId(id),
          });
          if (!submission)
            return res.status(404).send({ error: "Submission not found" });

          const updateResult = await submissionsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
          );
          if (updateResult.modifiedCount === 0) {
            return res
              .status(500)
              .send({ error: "Failed to update submission status" });
          }

          const task = await tasksCollection.findOne({
            _id: new ObjectId(submission.task_id),
          });
          const buyer = await usersCollection.findOne({
            email: submission.buyer_email,
          });

          if (status === "approved") {
            await usersCollection.updateOne(
              { email: submission.worker_email },
              { $inc: { coins: submission.payable_amount } }
            );

            await db.collection("notifications").insertOne({
              message: `You have earned $${submission.payable_amount} from ${buyer.name} for completing "${task.title}"`,
              toEmail: submission.worker_email,
              actionRoute: "/dashboard/worker-home",
              time: new Date(),
            });

            await db.collection("notifications").insertOne({
              message: `${buyer.name} approved submission (ID: ${submission._id}) for "${task.title}" by ${submission.worker_email}`,
              toEmail: ADMIN_EMAIL,
              actionRoute: "/dashboard/admin/submissions",
              time: new Date(),
            });

            await db.collection("notifications").insertOne({
              message: `You have successfully approved the submission for "${task.title}" by ${submission.worker_email}`,
              toEmail: buyer.email,
              actionRoute: "/dashboard/buyer-submissions",
              time: new Date(),
            });
          }

          if (status === "rejected") {
            await db.collection("notifications").insertOne({
              message: `${buyer.name} rejected your submission for "${task.title}"`,
              toEmail: submission.worker_email,
              actionRoute: "/dashboard/worker-home",
              time: new Date(),
            });

            await db.collection("notifications").insertOne({
              message: `${buyer.name} rejected submission (ID: ${submission._id}) for "${task.title}" by ${submission.worker_email}`,
              toEmail: ADMIN_EMAIL,
              actionRoute: "/dashboard/admin/submissions",
              time: new Date(),
            });

            await db.collection("notifications").insertOne({
              message: `You have rejected the submission for "${task.title}" by ${submission.worker_email}`,
              toEmail: buyer.email,
              actionRoute: "/dashboard/buyer-submissions",
              time: new Date(),
            });
          }

          res.send({
            success: true,
            modifiedCount: updateResult.modifiedCount,
          });
        } catch (error) {
          console.error("Error updating submission status:", error);
          res.status(500).send({ error: "Internal server error" });
        }
      }
    );

    // Notification

    app.get("/notifications", verifyFBToken(db), async (req, res) => {
      const email = req.query.email;

      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      try {
        const notifications = await db
          .collection("notifications")
          .find({ toEmail: email }) // Make sure this matches your DB field
          .sort({ time: -1 }) // Sort by newest first
          .toArray();

        res.status(200).json(notifications);
      } catch (error) {
        console.error("Failed to fetch notifications:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    // 4. PATCH Reject Submission
    app.patch(
      "/submissions/reject/:id",
      verifyFBToken(db),
      verifyBuyer,
      async (req, res) => {
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
      }
    );

    // my task
    app.post("/tasks", verifyFBToken(db), verifyBuyer, async (req, res) => {
      try {
        const {
          task_title,
          task_details,
          required_workers,
          payable_amount,
          completion_date,
          submission_info,
          task_image_url,
        } = req.body;

        // Validate required fields
        if (!task_title || !required_workers || !payable_amount) {
          return res.status(400).json({ error: "Missing required fields" });
        }

        const totalCost = required_workers * payable_amount;

        // Fetch buyer data to check coins
        const buyer = await usersCollection.findOne({
          email: req.decoded.email,
        });

        if (!buyer) {
          return res.status(404).json({ error: "Buyer not found" });
        }

        if (buyer.coins < totalCost) {
          return res
            .status(400)
            .json({ error: "Not enough coins. Please purchase more coins." });
        }

        // Deduct coins from buyer
        await usersCollection.updateOne(
          { email: req.decoded.email },
          { $inc: { coins: -totalCost } }
        );

        // Prepare task object
        const task = {
          task_title,
          task_detail: task_details,
          required_workers,
          payable_amount,
          completion_date: new Date(completion_date),
          submission_info,
          task_image_url,
          created_by: req.decoded.email,
          status: "pending",
          created_at: new Date(),
        };

        // Insert task
        const result = await tasksCollection.insertOne(task);

        res.status(201).json({ insertedId: result.insertedId });
      } catch (error) {
        console.error("Error creating task:", error);
        res.status(500).json({ error: "Failed to create task" });
      }
    });

    // GET: My Tasks
    app.get(
      "/tasks/my/:email",
      verifyFBToken(db),
      verifyBuyer,
      async (req, res) => {
        const email = req.params.email;
        const tasks = await db
          .collection("tasks")
          .find({ created_by: email })
          .sort({ compilation_date: -1 })
          .toArray();
        res.send(tasks);
      }
    );

    // PUT: Update Task
    app.put("/tasks/:id", verifyFBToken(db), verifyBuyer, async (req, res) => {
      const { task_title, task_detail, submission_info } = req.body;

      const result = await db.collection("tasks").updateOne(
        { _id: new ObjectId(req.params.id), created_by: req.decoded.email },
        {
          $set: {
            task_title,
            task_detail,
            submission_info,
          },
        }
      );

      res.send(result);
    });

    // DELETE: Delete Task (Buyer or Admin)
    app.delete(
      "/tasks/:id",
      verifyFBToken(db),
      verifyBuyer,
      async (req, res) => {
        const taskId = req.params.id;
        try {
          const task = await db.collection("tasks").findOne({
            _id: new ObjectId(taskId),
          });

          if (!task) {
            return res.status(404).send({ message: "Task not found" });
          }

          const isAdmin = req.decoded.role === "admin";
          const isOwner = task.created_by === req.decoded.email;

          if (!isAdmin && !isOwner) {
            return res.status(403).send({
              message:
                "Forbidden: You don't have permission to delete this task",
            });
          }

          const refill =
            (task.required_workers || 0) * (task.payable_amount || 0);

          const deleteResult = await db
            .collection("tasks")
            .deleteOne({ _id: new ObjectId(taskId) });

          if (deleteResult.deletedCount > 0 && task.status !== "completed") {
            await db
              .collection("users")
              .updateOne(
                { email: task.created_by },
                { $inc: { coins: refill } }
              );
          }

          res.send({ deleted: true, refillAmount: refill });
        } catch (error) {
          console.error("Error deleting task:", error);
          res.status(500).send({ message: "Internal server error" });
        }
      }
    );

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

    // ----------------------- Worker ---------------------------
    // GET /workers/top
    app.get("/workers/top", async (req, res) => {
      try {
        // Filter by role: 'worker', sort by coins descending
        const topWorkers = await usersCollection
          .find({ role: "worker" }) //  Only workers
          .sort({ coins: -1 })
          .limit(6)
          .project({ name: 1, photo: 1, coins: 1 }) // return only needed fields
          .toArray();

        res.send(topWorkers);
      } catch (error) {
        console.error("Error fetching top workers:", error);
        res.status(500).send({ error: "Internal Server Error" });
      }
    });

    app.get(
      "/submissions/worker/:email",
      verifyFBToken(db),
      verifyWorker,
      async (req, res) => {
        const { email } = req.params;
        try {
          const allSubmissions = await submissionsCollection
            .find({ worker_email: email })
            .toArray();
          console.log(allSubmissions);
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
      }
    );

    app.get(
      "/submissions/approved",
      verifyFBToken(db),
      verifyWorker,
      async (req, res) => {
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
      }
    );

    app.get(
      "/tasks/available",
      verifyFBToken(db),
      verifyWorker,
      async (req, res) => {
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
      }
    );

    // GET task by ID
    app.get("/tasks/:id", verifyFBToken(db), verifyWorker, async (req, res) => {
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
    app.post(
      "/submissions",
      verifyFBToken(db),
      verifyWorker,
      async (req, res) => {
        try {
          const data = req.body;
          console.log(" Incoming submission body:", data);

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
          } = data;

          if (!task_id || !worker_email || !submission_details || !task_title) {
            console.warn(" Missing required fields:", {
              task_id,
              task_title,
              worker_email,
              submission_details,
            });
            return res.status(400).send({ error: "Missing required fields." });
          }

          let taskObjectId;
          try {
            taskObjectId = new ObjectId(task_id);
          } catch (err) {
            console.warn(" Invalid ObjectId:", task_id);
            return res.status(400).send({ error: "Invalid task_id format." });
          }

          const newSubmission = {
            task_id: taskObjectId,
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

          const result = await submissionsCollection.insertOne(newSubmission);
          res.send(result);
        } catch (error) {
          console.error("POST /submissions error:", error);
          res.status(500).send({ error: "Failed to submit task." });
        }
      }
    );

    // GET /submissions/worker?email=worker@example.com
    app.get(
      "/submissions/worker",
      verifyFBToken(db),
      verifyWorker,
      async (req, res) => {
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
      }
    );

    app.post(
      "/withdrawals",
      verifyFBToken(db),
      verifyWorker,
      async (req, res) => {
        try {
          const withdrawal = req.body;

          const result = await withdrawalsCollection.insertOne({
            ...withdrawal,
            status: "pending", // Ensure it's marked as pending
            requestedAt: new Date(), // store creation time explicitly
          });

          res.status(201).send({ insertedId: result.insertedId });
        } catch (error) {
          console.error("Error processing withdrawal:", error);
          res.status(500).send({ error: "Internal Server Error" });
        }
      }
    );

    // ---------------------- ADMIN ----------------------

    // GET: All Users
    app.get(
      "/admin/users",
      verifyFBToken(db),
      verifyAdmin,
      async (req, res) => {
        const users = await usersCollection.find({}).toArray();
        res.send(users);
      }
    );

    // GET: All Tasks (Admin Only)
    app.get(
      "/admin/tasks",
      verifyFBToken(db),
      verifyAdmin,
      async (req, res) => {
        const tasks = await db
          .collection("tasks")
          .find()
          .sort({ created_at: -1 })
          .toArray();
        res.send(tasks);
      }
    );

    // GET: All Withdrawals with status=pending
    app.get(
      "/admin/withdrawals",
      verifyFBToken(db),
      verifyAdmin,
      async (req, res) => {
        const withdrawals = await withdrawalsCollection
          .find({ status: "pending" })
          .toArray();
        res.send(withdrawals);
      }
    );

    

    app.patch(
      "/admin/withdrawals/:id/approve",
      verifyFBToken(db),
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@microtask.com";

        const withdrawal = await withdrawalsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!withdrawal)
          return res.status(404).send({ error: "Withdrawal not found" });

        const updateStatus = await withdrawalsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "approved" } }
        );

        const deductCoin = await usersCollection.updateOne(
          { email: withdrawal.worker_email },
          { $inc: { coins: -withdrawal.withdrawal_coin } }
        );

        //  Notify admin
        await db.collection("notifications").insertOne({
          message: `Withdrawal of ${withdrawal.withdrawal_coin} coins approved for ${withdrawal.worker_email}`,
          toEmail: ADMIN_EMAIL,
          actionRoute: "/dashboard/admin/withdrawals",
          time: new Date(),
        });

        //  Optionally notify the worker
        await db.collection("notifications").insertOne({
          message: `Your withdrawal request of ${withdrawal.withdrawal_coin} coins has been approved.`,
          toEmail: withdrawal.worker_email,
          actionRoute: "/dashboard/worker-home",
          time: new Date(),
        });

        res.send({ approved: true, updated: updateStatus.modifiedCount > 0 });
      }
    );

    // PATCH: Update User Role
    app.patch(
      "/admin/users/:id/role",
      verifyFBToken(db),
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { role } = req.body;
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );
        res.send(result);
      }
    );

    // DELETE: User
    app.delete(
      "/admin/users/:id",
      verifyFBToken(db),
      verifyAdmin,
      async (req, res) => {
        const result = await usersCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.send(result);
      }
    );

    // GET: Admin Stats (worker count, buyer count, total coins, total payments)
    app.get("/admin/stats", async (req, res) => {
      const users = await usersCollection.find({}).toArray();
      const totalBuyers = users.filter((u) => u.role === "buyer").length;
      const totalWorkers = users.filter((u) => u.role === "worker").length;
      const totalCoins = users.reduce((sum, u) => sum + (u.coins || 0), 0);

      const payments = await paymentsCollection.find({}).toArray();
      const totalPayments = payments.reduce(
        (sum, p) => sum + (p.amount || 0),
        0
      );

      res.send({ totalBuyers, totalWorkers, totalCoins, totalPayments });
    });


    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
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
